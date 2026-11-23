/**
 * Ansible en el simulador: ansible, ansible-playbook, ansible-inventory, ansible-vault,
 * ansible-galaxy, ansible-doc y ansible-config. Se conecta a los otros equipos con el mismo ssh
 * del simulador (claves, known_hosts, firewall), escala con sudo según /etc/sudoers, y corre los
 * módulos de ansible-modules.ts. La salida imita la de ansible-core: banners, colores, los
 * resultados de cada equipo, las diferencias de --diff y el PLAY RECAP.
 */
import { register, type CommandContext } from './shell'
import type { System } from './system'
import { normalizePath } from './vfs'
import { connect } from './commands/ssh'
import { sudoRules } from './commands/users'
import { compareVersions, evaluate, JinjaError, lazyScope, render, templateValue, truthy, Undef, type Scope } from '../ansible/jinja'
import { emptyInventory, groupHosts, groupsByDepth, hostGroups, InventoryError, matchPattern, parseInventory, splitKv, type Inventory } from '../ansible/inventory'
import { decrypt, encrypt, encryptString, isVault, VaultError, VaultString } from '../ansible/vault'
import { errorContext, loadYaml, Unsafe, YamlLoadError } from '../ansible/yamlload'
import { MODULE_COLLECTION, ModuleArgError, REMOTE_MODULES, resolveAction, unifiedDiff, type FileDiff, type Result, type Target } from './ansible-modules'
import { lintFiles } from '../ansible/lint'

// ---------------------------------------------------------------------------------------
// Constantes y salida
// ---------------------------------------------------------------------------------------

export const CORE_VERSION: Record<'rocky' | 'ubuntu', string> = { rocky: '2.16.14', ubuntu: '2.16.3' }
const PY: Record<'rocky' | 'ubuntu', { version: string; build: string }> = {
  rocky: { version: '3.12.8', build: '(main, Dec  3 2024, 00:00:00) [GCC 14.2.1 20250110 (Red Hat 14.2.1-7)]' },
  ubuntu: { version: '3.12.3', build: '(main, Jun 18 2025, 17:59:45) [GCC 13.3.0]' },
}

const COLOR = { ok: '\x1b[0;32m', changed: '\x1b[0;33m', skip: '\x1b[0;36m', error: '\x1b[0;31m', unreach: '\x1b[1;31m', warn: '\x1b[1;35m', reset: '\x1b[0m', verbose: '\x1b[0;34m' }
const paint = (c: keyof typeof COLOR, s: string) => `${COLOR[c]}${s}${COLOR.reset}`

function banner(msg: string): string {
  const stars = Math.max(3, 79 - msg.length)
  return `\n${msg} ${'*'.repeat(stars)}\n`
}

/** JSON como lo muestra Ansible: claves ordenadas y los separadores de Python. */
export function pyJson(v: unknown, indent?: number, level = 0): string {
  const pad = indent ? ' '.repeat(indent * (level + 1)) : ''
  const end = indent ? ' '.repeat(indent * level) : ''
  const nl = indent ? '\n' : ''
  if (v === undefined || v === null) return 'null'
  if (v instanceof VaultString) return JSON.stringify('VALUE_SPECIFIED_IN_NO_LOG_PARAMETER')
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[${nl}${v.map((x) => pad + pyJson(x, indent, level + 1)).join(`,${indent ? nl : ' '}`)}${nl}${end}]`
  }
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (!entries.length) return '{}'
  return `{${nl}${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pyJson(x, indent, level + 1)}`).join(`,${indent ? nl : ' '}`)}${nl}${end}}`
}

/** Lo que se muestra de un resultado (sin las claves internas). */
function shown(r: Result): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) if (!['diff', 'invocation', '_ansible_no_log', '_internal', 'failed'].includes(k) && !k.startsWith('_ansible')) out[k] = v
  return out
}

// ---------------------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------------------

interface Cfg {
  file?: string
  inventory: string[]
  remoteUser?: string
  hostKeyChecking: boolean
  become: boolean
  becomeUser: string
  becomeAskPass: boolean
  rolesPath: string[]
  vaultPasswordFile?: string
  interpreterPython?: string
  privateKeyFile?: string
  gathering: 'implicit' | 'explicit' | 'smart'
  forks: number
  collectionsPath: string[]
}

function readIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let sec = 'defaults'
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*[#;].*$/, '').trim()
    if (!line) continue
    const s = /^\[([^\]]+)\]$/.exec(line)
    if (s) {
      sec = s[1].trim()
      out[sec] ??= {}
      continue
    }
    const kv = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(line)
    if (kv) (out[sec] ??= {})[kv[1].toLowerCase()] = kv[2].replace(/\s+[#;].*$/, '').trim()
  }
  return out
}

function isTrue(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def
  return ['yes', 'true', 'on', '1', 'y'].includes(v.toLowerCase())
}

function readFileSafe(ctx: CommandContext, path: string): string | undefined {
  try {
    return ctx.sys.vfs.readFile(path, ctx.sh.cred)
  } catch {
    return undefined
  }
}

function abs(ctx: CommandContext, p: string, base = ctx.sh.cwd): string {
  const e = p.replace(/^~(?=\/|$)/, ctx.sh.home)
  return normalizePath(e.startsWith('/') ? e : `${base}/${e}`)
}

function envVar(ctx: CommandContext, name: string): string | undefined {
  return ctx.sh.vars.get(name)
}

function loadCfg(ctx: CommandContext): Cfg {
  const candidates = [envVar(ctx, 'ANSIBLE_CONFIG'), `${ctx.sh.cwd}/ansible.cfg`, `${ctx.sh.home}/.ansible.cfg`, '/etc/ansible/ansible.cfg'].filter(Boolean) as string[]
  let file: string | undefined
  let ini: Record<string, Record<string, string>> = {}
  for (const c of candidates) {
    const t = readFileSafe(ctx, abs(ctx, c))
    if (t !== undefined) {
      file = abs(ctx, c)
      ini = readIni(t)
      break
    }
  }
  const d = ini.defaults ?? {}
  const pe = ini.privilege_escalation ?? {}
  const base = file ? file.replace(/\/[^/]+$/, '') : ctx.sh.cwd
  const rel = (p: string) => abs(ctx, p, base)
  const env = (n: string) => envVar(ctx, n)
  return {
    file,
    inventory: (env('ANSIBLE_INVENTORY') ?? d.inventory ?? d.hostfile ?? '/etc/ansible/hosts').split(',').map((s) => s.trim()).filter(Boolean).map((p) => (p.includes(',') ? p : rel(p))),
    remoteUser: env('ANSIBLE_REMOTE_USER') ?? d.remote_user,
    hostKeyChecking: isTrue(env('ANSIBLE_HOST_KEY_CHECKING') ?? d.host_key_checking, true),
    become: isTrue(env('ANSIBLE_BECOME') ?? pe.become, false),
    becomeUser: pe.become_user ?? 'root',
    becomeAskPass: isTrue(pe.become_ask_pass, false),
    rolesPath: (d.roles_path ?? '~/.ansible/roles:/usr/share/ansible/roles:/etc/ansible/roles').split(':').filter(Boolean).map(rel),
    vaultPasswordFile: env('ANSIBLE_VAULT_PASSWORD_FILE') ?? (d.vault_password_file ? rel(d.vault_password_file) : undefined),
    interpreterPython: d.interpreter_python,
    privateKeyFile: d.private_key_file ? rel(d.private_key_file) : undefined,
    gathering: (d.gathering as Cfg['gathering']) ?? 'implicit',
    forks: Number(d.forks ?? 5),
    collectionsPath: (d.collections_path ?? d.collections_paths ?? '~/.ansible/collections:/usr/share/ansible/collections').split(':').filter(Boolean).map(rel),
  }
}

function installedCore(sys: System): boolean {
  return sys.installed.has('ansible-core') || sys.installed.has('ansible')
}

// ---------------------------------------------------------------------------------------
// Opciones de línea de comandos
// ---------------------------------------------------------------------------------------

interface Opts {
  inventories: string[]
  limit?: string
  extraVars: Record<string, unknown>
  check: boolean
  diff: boolean
  verbose: number
  become: boolean
  becomeUser?: string
  askBecome: boolean
  user?: string
  privateKey?: string
  tags: string[]
  skipTags: string[]
  askVault: boolean
  vaultFile?: string
  forks?: number
  listHosts: boolean
  listTasks: boolean
  listTags: boolean
  syntaxCheck: boolean
  startAt?: string
  module?: string
  moduleArgs?: string
  oneLine: boolean
  rest: string[]
  version: boolean
  help: boolean
  error?: string
}

function parseOpts(ctx: CommandContext, args: string[]): Opts {
  const o: Opts = { inventories: [], extraVars: {}, check: false, diff: false, verbose: 0, become: false, askBecome: false, tags: [], skipTags: [], askVault: false, listHosts: false, listTasks: false, listTags: false, syntaxCheck: false, oneLine: false, rest: [], version: false, help: false }
  const a = [...args]
  const val = (flag: string, inline?: string) => {
    if (inline !== undefined) return inline
    const v = a.shift()
    if (v === undefined) o.error = `argument ${flag}: expected one argument`
    return v ?? ''
  }
  while (a.length) {
    let x = a.shift()!
    let inline: string | undefined
    const eq = /^(--[\w-]+)=(.*)$/.exec(x)
    if (eq) {
      x = eq[1]
      inline = eq[2]
    }
    if (/^-v+$/.test(x)) o.verbose += x.length - 1
    else if (x === '--verbose') o.verbose++
    else if (x === '-i' || x === '--inventory' || x === '--inventory-file') o.inventories.push(val(x, inline))
    else if (x === '-l' || x === '--limit') o.limit = val(x, inline)
    else if (x === '-e' || x === '--extra-vars') {
      const v = val(x, inline)
      if (v.startsWith('@')) {
        const t = readFileSafe(ctx, abs(ctx, v.slice(1)))
        if (t === undefined) o.error = `the file_name '${abs(ctx, v.slice(1))}' does not exist, or is not readable`
        else Object.assign(o.extraVars, (loadYaml(t).data as Record<string, unknown>) ?? {})
      } else if (/^\s*[{[]/.test(v)) {
        try {
          Object.assign(o.extraVars, JSON.parse(v))
        } catch {
          o.error = `Invalid JSON in extra vars: ${v}`
        }
      } else for (const [k, s] of Object.entries(splitKv(v))) o.extraVars[k] = s.replace(/^(['"])(.*)\1$/, '$2')
    } else if (x === '-C' || x === '--check') o.check = true
    else if (x === '-D' || x === '--diff') o.diff = true
    else if (x === '-b' || x === '--become') o.become = true
    else if (x === '--become-user') o.becomeUser = val(x, inline)
    else if (x === '-K' || x === '--ask-become-pass') o.askBecome = true
    else if (x === '-u' || x === '--user') o.user = val(x, inline)
    else if (x === '--private-key' || x === '--key-file') o.privateKey = val(x, inline)
    else if (x === '-t' || x === '--tags') o.tags.push(...val(x, inline).split(','))
    else if (x === '--skip-tags') o.skipTags.push(...val(x, inline).split(','))
    else if (x === '-J' || x === '--ask-vault-pass' || x === '--ask-vault-password') o.askVault = true
    else if (x === '--vault-password-file' || x === '--vault-pass-file') o.vaultFile = val(x, inline)
    else if (x === '--vault-id') {
      const v = val(x, inline)
      if (v.endsWith('@prompt') || v === 'prompt') o.askVault = true
      else o.vaultFile = v.replace(/^[^@]*@/, '')
    } else if (x === '-f' || x === '--forks') o.forks = Number(val(x, inline))
    else if (x === '--list-hosts') o.listHosts = true
    else if (x === '--list-tasks') o.listTasks = true
    else if (x === '--list-tags') o.listTags = true
    else if (x === '--syntax-check') o.syntaxCheck = true
    else if (x === '--start-at-task') o.startAt = val(x, inline)
    else if (x === '-m' || x === '--module-name') o.module = val(x, inline)
    else if (x === '-a' || x === '--args') o.moduleArgs = val(x, inline)
    else if (x === '-o' || x === '--one-line') o.oneLine = true
    else if (x === '--version') o.version = true
    else if (x === '-h' || x === '--help') o.help = true
    else if (x === '-k' || x === '--ask-pass') o.error = 'to use the \'ssh\' connection type with passwords or pkcs11_provider, you must install the sshpass program'
    else if (x.startsWith('-') && x.length > 1) o.error = `unrecognized arguments: ${x}`
    else o.rest.push(x)
  }
  return o
}

function versionText(ctx: CommandContext, prog: string, cfg: Cfg): string {
  const d = ctx.sys.distro
  const py = PY[d]
  const lib = d === 'ubuntu' ? '/usr/lib/python3/dist-packages' : '/usr/lib/python3.12/site-packages'
  return `${prog} [core ${CORE_VERSION[d]}]\n  config file = ${cfg.file ?? 'None'}\n  configured module search path = ['${ctx.sh.home}/.ansible/plugins/modules', '/usr/share/ansible/plugins/modules']\n  ansible python module location = ${lib}/ansible\n  ansible collection location = ${ctx.sh.home}/.ansible/collections:/usr/share/ansible/collections\n  executable location = /usr/bin/${prog}\n  python version = ${py.version} ${py.build} (/usr/bin/python3)\n  jinja version = ${d === 'ubuntu' ? '3.1.2' : '3.1.6'}\n  libyaml = True\n`
}

// ---------------------------------------------------------------------------------------
// Vault y carga de archivos
// ---------------------------------------------------------------------------------------

class AnsibleError extends Error {}

interface Run {
  ctx: CommandContext
  cfg: Cfg
  o: Opts
  inv: Inventory
  vaultPass?: string
  warnings: Set<string>
  out: (s: string) => void
}

function warn(run: Run, msg: string) {
  if (run.warnings.has(msg)) return
  run.warnings.add(msg)
  run.out(paint('warn', `[WARNING]: ${msg}`) + '\n')
}

function getVaultPass(ctx: CommandContext, cfg: Cfg, o: Opts): string | undefined {
  if (o.askVault) {
    ctx.out('Vault password: ')
    const l = ctx.stdin.readLine()
    ctx.out('\n')
    return l ?? ''
  }
  const f = o.vaultFile ? abs(ctx, o.vaultFile) : cfg.vaultPasswordFile
  if (f) {
    const t = readFileSafe(ctx, f)
    if (t === undefined) throw new AnsibleError(`The vault password file ${f} was not found`)
    return t.split('\n')[0].trim()
  }
  return undefined
}

function unvault(run: Run, text: string, file: string): string {
  if (!isVault(text)) return text
  if (run.vaultPass === undefined) throw new AnsibleError('Attempting to decrypt but no vault secrets found')
  try {
    return decrypt(text, run.vaultPass, file)
  } catch (e) {
    throw new AnsibleError((e as VaultError).message)
  }
}

/** Reemplaza las variables cifradas (!vault) por su valor y las !unsafe por texto sin plantillas. */
function unvaultDeep(run: Run, v: unknown, file: string): unknown {
  if (v instanceof VaultString) return unvault(run, v.text, file)
  if (v instanceof Unsafe) return v.value.replace(/\{\{/g, '{{ "{{" }}').replace(/\{%/g, '{{ "{%" }}')
  // En el lugar, para no perder las líneas de cada diccionario (los mensajes de error las usan).
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unvaultDeep(run, v[i], file)
    return v
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of Object.keys(o)) o[k] = unvaultDeep(run, o[k], file)
    return o
  }
  return v
}

function readControl(run: Run, path: string): string {
  const t = readFileSafe(run.ctx, path)
  if (t === undefined) throw new AnsibleError(`Unable to retrieve file contents\nCould not find or access '${path}' on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`)
  return t
}

function loadYamlFile(run: Run, path: string): { data: unknown; lines: string[]; where: WeakMap<object, { line: number; col: number }> } {
  const raw = readControl(run, path)
  const text = unvault(run, raw, path)
  try {
    const l = loadYaml(text)
    return { data: unvaultDeep(run, l.data, path), lines: l.lines, where: l.where }
  } catch (e) {
    if (e instanceof YamlLoadError) {
      throw new AnsibleError(`We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${e.message}\n\n${errorContext(path, text.split('\n'), e.line, e.col)}`)
    }
    throw e
  }
}

function varsFile(run: Run, path: string): Record<string, unknown> {
  const d = loadYamlFile(run, path).data
  if (d === null || d === undefined) return {}
  if (typeof d !== 'object' || Array.isArray(d)) throw new AnsibleError(`${path} must be stored as a dictionary/hash`)
  return d as Record<string, unknown>
}

/** group_vars/<grupo>.yml o group_vars/<grupo>/*.yml (y lo mismo con host_vars). */
function dirVars(run: Run, base: string, kind: 'group_vars' | 'host_vars', name: string): Record<string, unknown> {
  const vfs = run.ctx.sys.vfs
  const cred = run.ctx.sh.cred
  const out: Record<string, unknown> = {}
  for (const ext of ['', '.yml', '.yaml', '.json']) {
    const p = `${base}/${kind}/${name}${ext}`
    let st
    try {
      st = vfs.stat(p, cred)
    } catch {
      continue
    }
    if (st.type === 'dir') {
      for (const f of vfs.readdir(p, cred).sort()) if (/\.(ya?ml|json)$/.test(f) || !f.includes('.')) Object.assign(out, varsFile(run, `${p}/${f}`))
    } else Object.assign(out, varsFile(run, p))
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------------------

interface InvLoad {
  inv: Inventory
  /** Carpetas donde buscar group_vars y host_vars del inventario. */
  dirs: string[]
}

function loadInventory(run: Pick<Run, 'ctx' | 'cfg' | 'o' | 'warnings' | 'out'> & { vaultPass?: string }, sources: string[]): InvLoad {
  const ctx = run.ctx
  const inv = emptyInventory()
  const dirs: string[] = []
  let parsed = 0
  for (const src of sources) {
    if (src.includes(',') && readFileSafe(ctx, abs(ctx, src)) === undefined) {
      for (const h of src.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!inv.hosts.has(h)) inv.hosts.set(h, {})
        inv.groups.get('ungrouped')!.hosts.push(h)
      }
      parsed++
      continue
    }
    const path = abs(ctx, src)
    let st
    try {
      st = ctx.sys.vfs.stat(path, ctx.sh.cred)
    } catch {
      warn(run as Run, `Unable to parse ${path} as an inventory source`)
      continue
    }
    const files: string[] = []
    if (st.type === 'dir') {
      dirs.push(path)
      for (const f of ctx.sys.vfs.readdir(path, ctx.sh.cred).sort()) {
        if (f.startsWith('.') || ['group_vars', 'host_vars'].includes(f) || /\.(retry|pyc|cfg|md|orig|bak|ini~)$/.test(f) || f.endsWith('~')) continue
        try {
          if (ctx.sys.vfs.stat(`${path}/${f}`, ctx.sh.cred).type === 'file') files.push(`${path}/${f}`)
        } catch {
          // ilegible
        }
      }
    } else {
      dirs.push(path.replace(/\/[^/]+$/, '') || '/')
      files.push(path)
    }
    for (const f of files) {
      try {
        let text = readFileSafe(ctx, f) ?? ''
        if (isVault(text)) text = unvault(run as Run, text, f)
        parseInventory(text, f, inv)
        parsed++
      } catch (e) {
        const plugin = /\.ya?ml$/.test(f) ? 'yaml' : 'ini'
        warn(run as Run, ` * Failed to parse ${f} with ${plugin} plugin: ${(e as Error).message}`)
        warn(run as Run, `Unable to parse ${f} as an inventory source`)
      }
    }
  }
  for (const w of inv.warnings) warn(run as Run, w)
  if (!parsed) warn(run as Run, 'No inventory was parsed, only implicit localhost is available')
  return { inv, dirs }
}

// ---------------------------------------------------------------------------------------
// Conexiones
// ---------------------------------------------------------------------------------------

interface Conn {
  sys: System
  user: string
  local: boolean
}

interface HostState {
  name: string
  conn?: Conn
  unreachable?: string
  failed: boolean
  /** Variables que agregan set_fact y register durante la corrida. */
  runVars: Record<string, unknown>
  facts?: Record<string, unknown>
  notified: string[]
  stats: { ok: number; changed: number; unreachable: number; failed: number; skipped: number; rescued: number; ignored: number }
  ended?: boolean
}

function sudoNeedsPassword(sys: System, user: string): 'nopasswd' | 'passwd' | 'none' {
  if (user === 'root') return 'nopasswd'
  const groups = sys.groupsOf(user)
  const fake = { sys } as unknown as CommandContext
  let found: 'nopasswd' | 'passwd' | 'none' = 'none'
  for (const rule of sudoRules(fake)) {
    const m = /^(\S+)\s+\S+\s*=\s*(\([^)]*\)\s*)?((NO)?PASSWD:\s*)?(.+)$/.exec(rule)
    if (!m) continue
    const who = m[1].split(',')
    if (!who.some((w) => w === user || w === 'ALL' || (w.startsWith('%') && groups.includes(w.slice(1))))) continue
    if (!m[5].split(',').map((c) => c.trim()).includes('ALL')) continue
    found = m[4] ? 'nopasswd' : found === 'nopasswd' ? found : 'passwd'
  }
  return found
}

// ---------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------

function gatherFacts(sys: System, user: string): Record<string, unknown> {
  const ips = sys.ownIps().filter((ip) => ip !== '127.0.0.1')
  const iface = sys.interfaces.find((i) => i.name !== 'lo')
  const ubuntu = sys.distro === 'ubuntu'
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const route = sys.routes.find((r) => r.net === 'default')
  return {
    hostname: sys.hostname.split('.')[0],
    nodename: sys.hostname,
    fqdn: sys.hostname,
    domain: sys.hostname.includes('.') ? sys.hostname.split('.').slice(1).join('.') : '',
    distribution: ubuntu ? 'Ubuntu' : 'Rocky',
    distribution_major_version: ubuntu ? '24' : '10',
    distribution_version: ubuntu ? '26.04' : '10.0',
    distribution_release: ubuntu ? 'resolute' : 'Red Quartz',
    distribution_file_variety: ubuntu ? 'Debian' : 'RedHat',
    os_family: ubuntu ? 'Debian' : 'RedHat',
    system: 'Linux',
    kernel: sys.kernelRelease ?? (ubuntu ? '7.0.0-44-generic' : '6.12.0-55.12.1.el10_0.x86_64'),
    architecture: 'x86_64',
    machine: 'x86_64',
    pkg_mgr: ubuntu ? 'apt' : 'dnf',
    service_mgr: 'systemd',
    python_version: PY[sys.distro].version,
    python: { executable: '/usr/bin/python3', version: { major: 3, minor: 12, micro: Number(PY[sys.distro].version.split('.')[2]) } },
    processor_count: 1,
    processor_cores: sys.ncpu,
    processor_vcpus: sys.ncpu,
    processor_threads_per_core: 1,
    memtotal_mb: Math.round(sys.memTotalKb / 1024),
    memfree_mb: Math.round(sys.memTotalKb / 1024 / 2),
    default_ipv4: { address: ips[0] ?? '127.0.0.1', interface: iface?.name ?? 'eth0', gateway: route?.via ?? '', netmask: '255.255.255.0', network: (ips[0] ?? '127.0.0.1').replace(/\.\d+$/, '.0') },
    all_ipv4_addresses: ips,
    interfaces: ['lo', ...sys.interfaces.filter((i) => i.name !== 'lo').map((i) => i.name)],
    dns: { nameservers: sys.dns },
    user_id: user,
    user_dir: sys.users.get(user)?.home ?? '/',
    env: { HOME: sys.users.get(user)?.home ?? '/', USER: user, LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' },
    selinux: ubuntu ? { status: 'disabled' } : { status: 'enabled', mode: 'enforcing', config_mode: 'enforcing', type: 'targeted' },
    virtualization_type: sys.physical ? 'NA' : 'kvm',
    virtualization_role: sys.physical ? 'NA' : 'guest',
    uptime_seconds: Math.floor((Date.now() - sys.bootTime) / 1000),
    date_time: { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, iso8601: now.toISOString().replace(/\.\d+Z$/, 'Z'), year: String(now.getFullYear()), epoch: String(Math.floor(now.getTime() / 1000)), tz: sys.clock.timezone },
    lsb: ubuntu ? { id: 'Ubuntu', codename: 'resolute', release: '26.04', major_release: '26', description: 'Ubuntu 26.04.1 LTS' } : {},
    mounts: [{ mount: '/', device: ubuntu ? '/dev/mapper/ubuntu--vg-ubuntu--lv' : '/dev/mapper/rl-root', fstype: ubuntu ? 'ext4' : 'xfs', size_total: 52_403_200 * 1024, size_available: 30_000_000 * 1024 }],
    discovered_interpreter_python: '/usr/bin/python3',
  }
}

// ---------------------------------------------------------------------------------------
// Playbooks: modelo
// ---------------------------------------------------------------------------------------

const TASK_KEYS = new Set(
  'name action args async become become_exe become_flags become_method become_user changed_when check_mode collections connection debugger delay delegate_facts delegate_to diff environment failed_when ignore_errors ignore_unreachable local_action loop loop_control module_defaults no_log notify poll port register remote_user retries run_once tags throttle timeout until vars when with_items with_dict with_list with_fileglob with_together with_sequence with_nested with_subelements with_indexed_items with_flattened listen any_errors_fatal'.split(' '),
)
const BLOCK_KEYS = new Set([...TASK_KEYS, 'block', 'rescue', 'always'])
const PLAY_KEYS = new Set(
  'name hosts become become_user become_method become_flags gather_facts gather_subset gather_timeout vars vars_files vars_prompt tasks handlers roles pre_tasks post_tasks remote_user serial strategy tags environment any_errors_fatal max_fail_percentage connection collections module_defaults ignore_errors ignore_unreachable check_mode diff order force_handlers port run_once throttle timeout no_log debugger fact_path'.split(' '),
)

interface RoleRef {
  name: string
  path: string
  defaults: Record<string, unknown>
  vars: Record<string, unknown>
  params: Record<string, unknown>
}

interface Task {
  kind: 'task' | 'block'
  name?: string
  action?: string
  short?: string
  args: Record<string, unknown>
  raw: Record<string, unknown>
  file: string
  line: number
  col: number
  lines: string[]
  role?: RoleRef
  tags: string[]
  when: unknown[]
  /** become heredado del bloque o del rol. */
  inherited: Record<string, unknown>
  block?: Task[]
  rescue?: Task[]
  always?: Task[]
  /** Carpeta del archivo, para include_tasks relativos. */
  dir: string
}

interface Play {
  name: string
  hosts: string
  raw: Record<string, unknown>
  file: string
  index: number
  sections: { name: 'pre_tasks' | 'roles' | 'tasks' | 'post_tasks'; tasks: Task[] }[]
  handlers: Task[]
  vars: Record<string, unknown>
  varsFiles: unknown[]
  roles: RoleRef[]
}

function errAt(t: { file: string; line: number; col: number; lines: string[] }, msg: string): AnsibleError {
  return new AnsibleError(`${msg}\n\n${errorContext(t.file, t.lines, t.line, t.col)}`)
}

function installedCollections(run: Run, playDir?: string): Map<string, string> {
  const out = new Map<string, string>()
  const vfs = run.ctx.sys.vfs
  const cred = run.ctx.sh.cred
  if (run.ctx.sys.installed.has('ansible')) for (const [c, v] of Object.entries(FULL_COLLECTIONS)) out.set(c, v)
  const roots = [...run.cfg.collectionsPath, ...(playDir ? [`${playDir}/collections`] : [])]
  for (const r of roots) {
    const base = `${r}/ansible_collections`
    let nss: string[]
    try {
      nss = vfs.readdir(base, cred)
    } catch {
      continue
    }
    for (const ns of nss) {
      let names: string[]
      try {
        names = vfs.readdir(`${base}/${ns}`, cred)
      } catch {
        continue
      }
      for (const n of names) {
        let version = '1.0.0'
        try {
          version = (JSON.parse(vfs.readFile(`${base}/${ns}/${n}/MANIFEST.json`, cred)) as { collection_info: { version: string } }).collection_info.version
        } catch {
          // sin manifiesto
        }
        if (!out.has(`${ns}.${n}`)) out.set(`${ns}.${n}`, version)
      }
    }
  }
  return out
}

export const FULL_COLLECTIONS: Record<string, string> = {
  'ansible.posix': '1.5.4',
  'ansible.windows': '2.2.0',
  'community.general': '8.3.0',
  'community.mysql': '3.8.0',
  'community.postgresql': '3.3.0',
  'community.windows': '2.1.0',
  'community.docker': '3.7.0',
}

/** Versiones publicadas en Galaxy (la primera es la última), para resolver requirements.yml. */
const GALAXY_VERSIONS: Record<string, string[]> = {
  'ansible.posix': ['2.1.0', '2.0.0', '1.6.2', '1.5.4'],
  'ansible.windows': ['3.2.0', '3.0.0', '2.8.0', '2.5.0'],
  'community.general': ['12.0.1', '11.4.1', '10.7.4', '9.5.10'],
  'community.mysql': ['3.15.0', '3.14.0'],
  'community.postgresql': ['4.1.0', '4.0.0', '3.14.2', '3.4.1'],
  'community.windows': ['3.0.1', '3.0.0', '2.4.0', '2.2.0'],
  'community.docker': ['5.0.0', '4.8.1', '3.13.10'],
  'ansible.utils': ['6.0.0', '5.1.2'],
  'microsoft.ad': ['1.9.2', '1.8.1'],
  'chocolatey.chocolatey': ['1.5.3', '1.5.1'],
}

/** ¿La versión cumple con ">=2.0.0,<3.0.0", "==1.2.0", "1.2.0" o "*"? */
function versionMatches(v: string, spec: string): boolean {
  return spec
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== '*')
    .every((c) => {
      const m = /^(>=|<=|==|!=|>|<)?\s*(.+)$/.exec(c)!
      const r = compareVersions(v, m[2])
      return { '>=': r >= 0, '<=': r <= 0, '>': r > 0, '<': r < 0, '!=': r !== 0, '==': r === 0, '': r === 0 }[m[1] ?? '']!
    })
}

function resolveGalaxyVersion(name: string, spec: string | undefined): string | undefined {
  const known = GALAXY_VERSIONS[name] ?? ['1.0.0']
  if (!spec || spec === '*') return known[0]
  const hit = known.find((v) => versionMatches(v, spec))
  if (hit) return hit
  const exact = /^(==)?\s*(\d+\.\d+\.\d+)$/.exec(spec.trim())
  return exact ? exact[2] : undefined
}

class Loader {
  constructor(
    private run: Run,
    private playDir: string,
  ) {}

  collections = new Map<string, string>()

  task(raw: unknown, file: string, lines: string[], where: WeakMap<object, { line: number; col: number }>, dir: string, role?: RoleRef, inheritedTags: string[] = [], inherited: Record<string, unknown> = {}, handler = false): Task[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AnsibleError(`A malformed block was encountered while loading tasks: ${JSON.stringify(raw)} should be a list or None but is ${Array.isArray(raw) ? 'list' : typeof raw}`)
    const r = raw as Record<string, unknown>
    const pos = where.get(r) ?? { line: 1, col: 1 }
    const base = { file, line: pos.line, col: pos.col, lines }
    const tags = [...inheritedTags, ...toList(r.tags).map(String)]
    const when = r.when === undefined ? [] : Array.isArray(r.when) ? r.when : [r.when]
    if ('block' in r) {
      for (const k of Object.keys(r)) if (!BLOCK_KEYS.has(k)) throw errAt(base, `'${k}' is not a valid attribute for a Block`)
      const inh = { ...inherited, ...pick(r, ['become', 'become_user', 'ignore_errors', 'vars', 'environment', 'check_mode', 'diff', 'delegate_to', 'any_errors_fatal']) }
      const sub = (k: 'block' | 'rescue' | 'always') => (Array.isArray(r[k]) ? (r[k] as unknown[]).flatMap((x) => this.task(x, file, lines, where, dir, role, tags, inh)) : [])
      return [{ kind: 'block', name: r.name as string | undefined, args: {}, raw: r, ...base, role, tags, when, inherited: inh, block: sub('block'), rescue: sub('rescue'), always: sub('always'), dir }]
    }
    const actions = Object.keys(r).filter((k) => !TASK_KEYS.has(k) && !(k.startsWith('with_') && k.length > 5))
    if (r.action) actions.push(String(r.action).split(/\s+/)[0])
    if (r.local_action) actions.push(typeof r.local_action === 'string' ? r.local_action.split(/\s+/)[0] : String((r.local_action as Record<string, unknown>).module))
    if (!actions.length) throw errAt(base, 'no module/action detected in task.')
    const known = actions.filter((a) => resolveAction(a))
    if (actions.length > 1) {
      if (known.length === 1) {
        const bad = actions.find((a) => a !== known[0])!
        throw errAt(base, `${bad.includes('.') ? `couldn't resolve module/action '${bad}'. This often indicates a misspelling, missing collection, or incorrect module path.` : `'${bad}' is not a valid attribute for a ${handler ? 'Handler' : 'Task'}`}`)
      }
      throw errAt(base, `conflicting action statements: ${actions.join(', ')}`)
    }
    const action = actions[0]
    const res = resolveAction(action)
    if (!res) throw errAt(base, `couldn't resolve module/action '${action}'. This often indicates a misspelling, missing collection, or incorrect module path.`)
    if (res.collection !== 'ansible.builtin' && !this.collections.has(res.collection)) {
      throw errAt(base, `couldn't resolve module/action '${action}'. This often indicates a misspelling, missing collection, or incorrect module path.`)
    }
    let args: Record<string, unknown> = {}
    const v = r.action ? String(r.action).split(/\s+/).slice(1).join(' ') || r.args : r[action]
    if (typeof v === 'string') {
      if (['command', 'shell', 'raw', 'script', 'include_tasks', 'import_tasks', 'include_vars', 'meta'].includes(res.short)) args = { _raw_params: v }
      else args = Object.fromEntries(Object.entries(splitKv(v)).map(([k, s]) => [k, s.replace(/^(['"])(.*)\1$/, '$2')]))
    } else if (v && typeof v === 'object') args = { ...(v as Record<string, unknown>) }
    else if (v !== null && v !== undefined) args = { _raw_params: String(v) }
    if (r.args && typeof r.args === 'object') args = { ...args, ...(r.args as Record<string, unknown>) }
    const t: Task = { kind: 'task', name: r.name as string | undefined, action, short: res.short, args, raw: r, ...base, role, tags, when, inherited, dir }
    // import_tasks e import_role se resuelven al cargar (estáticos)
    if (res.short === 'import_tasks') {
      const f = String(args._raw_params ?? args.file)
      const path = this.findTasksFile(f, dir, role)
      const l = loadYamlFile(this.run, path)
      return ((l.data as unknown[]) ?? []).flatMap((x) => this.task(x, path, l.lines, l.where, path.replace(/\/[^/]+$/, ''), role, tags, { ...inherited, ...pick(r, ['become', 'become_user', 'vars']) }))
    }
    if (res.short === 'import_role') {
      const ref = this.role(String(args.name), (r.vars as Record<string, unknown>) ?? {}, base)
      return this.roleTasks(ref, tags, String(args.tasks_from ?? 'main'))
    }
    return [t]
  }

  tasks(raw: unknown, file: string, lines: string[], where: WeakMap<object, { line: number; col: number }>, dir: string, role?: RoleRef, tags: string[] = [], handler = false): Task[] {
    if (raw === null || raw === undefined) return []
    if (!Array.isArray(raw)) throw new AnsibleError(`A malformed block was encountered while loading tasks: ${pyJson(raw)} should be a list or None but is <class 'ansible.parsing.yaml.objects.AnsibleMapping'>\n\nThe error appears to be in '${file}'`)
    return raw.flatMap((x) => this.task(x, file, lines, where, dir, role, tags, {}, handler))
  }

  findTasksFile(f: string, dir: string, role?: RoleRef): string {
    const cands = [role ? `${role.path}/tasks/${f}` : '', `${dir}/${f}`, abs(this.run.ctx, f, this.playDir)].filter(Boolean)
    for (const c of cands) if (readFileSafe(this.run.ctx, c) !== undefined) return c
    throw new AnsibleError(`Could not find or access '${f}'\nSearched in:\n${cands.map((c) => `\t${c}`).join('\n')}\n on the Ansible Controller.`)
  }

  role(name: string, params: Record<string, unknown>, where?: { file: string; line: number; col: number; lines: string[] }): RoleRef {
    const paths = [`${this.playDir}/roles/${name}`, ...this.run.cfg.rolesPath.map((p) => `${p}/${name}`), `${this.playDir}/${name}`]
    const found = paths.find((p) => {
      try {
        return this.run.ctx.sys.vfs.stat(p, this.run.ctx.sh.cred).type === 'dir'
      } catch {
        return false
      }
    })
    if (!found) {
      const msg = `the role '${name}' was not found in ${[`${this.playDir}/roles`, ...this.run.cfg.rolesPath, this.playDir].join(':')}`
      throw where ? errAt(where, msg) : new AnsibleError(msg)
    }
    const opt = (sub: string) => {
      for (const f of [`${found}/${sub}/main.yml`, `${found}/${sub}/main.yaml`, `${found}/${sub}/main`]) if (readFileSafe(this.run.ctx, f) !== undefined) return varsFile(this.run, f)
      return {}
    }
    return { name: name.split('/').pop()!, path: found, defaults: opt('defaults'), vars: opt('vars'), params }
  }

  roleTasks(ref: RoleRef, tags: string[], from = 'main'): Task[] {
    // dependencias de meta/main.yml primero
    const out: Task[] = []
    const metaFile = [`${ref.path}/meta/main.yml`, `${ref.path}/meta/main.yaml`].find((f) => readFileSafe(this.run.ctx, f) !== undefined)
    if (metaFile) {
      const meta = loadYamlFile(this.run, metaFile).data as { dependencies?: unknown[] } | null
      for (const dep of meta?.dependencies ?? []) {
        const name = typeof dep === 'string' ? dep : String((dep as Record<string, unknown>).role ?? (dep as Record<string, unknown>).name)
        out.push(...this.roleTasks(this.role(name, typeof dep === 'object' ? (dep as Record<string, unknown>) : {}), tags))
      }
    }
    const f = [`${ref.path}/tasks/${from}.yml`, `${ref.path}/tasks/${from}.yaml`, `${ref.path}/tasks/${from}`].find((x) => readFileSafe(this.run.ctx, x) !== undefined)
    if (!f) return out
    const l = loadYamlFile(this.run, f)
    out.push(...this.tasks(l.data, f, l.lines, l.where, `${ref.path}/tasks`, ref, tags))
    return out
  }

  roleHandlers(ref: RoleRef): Task[] {
    const f = [`${ref.path}/handlers/main.yml`, `${ref.path}/handlers/main.yaml`].find((x) => readFileSafe(this.run.ctx, x) !== undefined)
    if (!f) return []
    const l = loadYamlFile(this.run, f)
    return this.tasks(l.data, f, l.lines, l.where, `${ref.path}/handlers`, ref, [], true)
  }

  playbook(path: string): Play[] {
    const l = loadYamlFile(this.run, path)
    this.collections = installedCollections(this.run, this.playDir)
    if (l.data === null || l.data === undefined) throw new AnsibleError(`Empty playbook, nothing to do: ${path}`)
    if (!Array.isArray(l.data)) throw new AnsibleError(`A playbook must be a list of plays, got a <class 'ansible.parsing.yaml.objects.AnsibleMapping'> instead\n\n${errorContext(path, l.lines, 1, 1)}`)
    const plays: Play[] = []
    l.data.forEach((raw, index) => {
      const r = raw as Record<string, unknown>
      const pos = l.where.get(r) ?? { line: 1, col: 1 }
      const base = { file: path, line: pos.line, col: pos.col, lines: l.lines }
      if ('import_playbook' in r || 'ansible.builtin.import_playbook' in r) {
        const f = abs(this.run.ctx, String(r.import_playbook ?? r['ansible.builtin.import_playbook']), path.replace(/\/[^/]+$/, ''))
        plays.push(...this.playbook(f))
        return
      }
      for (const k of Object.keys(r)) if (!PLAY_KEYS.has(k)) throw errAt(base, `'${k}' is not a valid attribute for a Play`)
      if (r.hosts === undefined || r.hosts === null) throw errAt(base, "the field 'hosts' is required but was not set")
      const playTags = toList(r.tags).map(String)
      const roles = toList(r.roles as unknown).map((x) => {
        const spec = typeof x === 'string' ? { role: x } : (x as Record<string, unknown>)
        const name = String(spec.role ?? spec.name)
        const params = Object.fromEntries(Object.entries(spec).filter(([k]) => !['role', 'name', 'tags', 'when', 'become', 'vars'].includes(k)))
        Object.assign(params, (spec.vars as Record<string, unknown>) ?? {})
        return { ref: this.role(name, params, base), tags: toList(spec.tags).map(String), when: spec.when }
      })
      const sec = (k: 'pre_tasks' | 'tasks' | 'post_tasks') => this.tasks(r[k], path, l.lines, l.where, path.replace(/\/[^/]+$/, ''), undefined, playTags)
      const roleTasks = roles.flatMap((x) => this.roleTasks(x.ref, [...playTags, ...x.tags]).map((t) => ({ ...t, when: x.when !== undefined ? [...toList(x.when), ...t.when] : t.when })))
      const handlers = [...this.tasks(r.handlers, path, l.lines, l.where, path.replace(/\/[^/]+$/, ''), undefined, [], true), ...roles.flatMap((x) => this.roleHandlers(x.ref))]
      plays.push({
        name: String(r.name ?? r.hosts),
        hosts: Array.isArray(r.hosts) ? r.hosts.join(',') : String(r.hosts),
        raw: r,
        file: path,
        index: index + 1,
        sections: [
          { name: 'pre_tasks', tasks: sec('pre_tasks') },
          { name: 'roles', tasks: roleTasks },
          { name: 'tasks', tasks: sec('tasks') },
          { name: 'post_tasks', tasks: sec('post_tasks') },
        ],
        handlers,
        vars: (r.vars as Record<string, unknown>) ?? {},
        varsFiles: toList(r.vars_files as unknown),
        roles: roles.map((x) => x.ref),
      })
    })
    return plays
  }
}

function toList(v: unknown): unknown[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return [v]
}
function pick(r: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
}

// ---------------------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------------------

const OMIT = '__omit_place_holder__6f4a1c2e9b'

class Executor {
  hosts = new Map<string, HostState>()
  invDirs: string[] = []
  playDir: string
  rc = 0
  aborted = false
  constructor(
    private run: Run,
    playDir: string,
  ) {
    this.playDir = playDir
  }

  state(h: string): HostState {
    let s = this.hosts.get(h)
    if (!s) {
      s = { name: h, failed: false, runVars: {}, notified: [], stats: { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 } }
      this.hosts.set(h, s)
    }
    return s
  }

  /** Variables del inventario de un equipo (grupos de padre a hijo, después las del equipo). */
  inventoryVars(h: string): Record<string, unknown> {
    const inv = this.run.inv
    const out: Record<string, unknown> = {}
    const add = (o: Record<string, unknown>) => Object.assign(out, o)
    add(inv.groups.get('all')?.vars ?? {})
    for (const d of this.invDirs) add(dirVars(this.run, d, 'group_vars', 'all'))
    if (this.playDir) add(dirVars(this.run, this.playDir, 'group_vars', 'all'))
    for (const g of groupsByDepth(inv, h)) {
      add(inv.groups.get(g)?.vars ?? {})
      for (const d of this.invDirs) add(dirVars(this.run, d, 'group_vars', g))
      if (this.playDir) add(dirVars(this.run, this.playDir, 'group_vars', g))
    }
    add(inv.hosts.get(h) ?? {})
    for (const d of this.invDirs) add(dirVars(this.run, d, 'host_vars', h))
    if (this.playDir) add(dirVars(this.run, this.playDir, 'host_vars', h))
    return out
  }

  private invCache = new Map<string, Record<string, unknown>>()
  invVars(h: string) {
    let v = this.invCache.get(h)
    if (!v) {
      v = this.inventoryVars(h)
      this.invCache.set(h, v)
    }
    return v
  }

  magic(h: string, play?: Play, playHosts: string[] = []): Record<string, unknown> {
    const inv = this.run.inv
    const groups: Record<string, string[]> = {}
    for (const g of inv.groups.keys()) groups[g] = groupHosts(inv, g)
    groups.all = [...inv.hosts.keys()]
    const invVars = (k: string) => this.invVars(k)
    const stateOf = (k: string) => this.hosts.get(k)
    const hostvars = new Proxy(
      {},
      {
        get(_t, k) {
          if (typeof k !== 'string' || !(inv.hosts.has(k) || k === 'localhost')) return undefined
          const st = stateOf(k)
          return { ...invVars(k), ...(st?.facts ? { ansible_facts: st.facts, ...prefixFacts(st.facts) } : {}), ...(st?.runVars ?? {}), inventory_hostname: k, group_names: hostGroups(inv, k).filter((g) => g !== 'ungrouped') }
        },
        has: (_t, k) => typeof k === 'string' && inv.hosts.has(k),
        ownKeys: () => [...inv.hosts.keys()],
        getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && inv.hosts.has(k) ? { enumerable: true, configurable: true } : undefined),
      },
    )
    const v = CORE_VERSION[this.run.ctx.sys.distro]
    return {
      inventory_hostname: h,
      inventory_hostname_short: h.split('.')[0],
      inventory_dir: this.invDirs[0],
      groups,
      group_names: hostGroups(inv, h).filter((g) => g !== 'ungrouped'),
      hostvars,
      play_hosts: playHosts,
      ansible_play_hosts: playHosts.filter((x) => !this.state(x).failed && !this.state(x).unreachable),
      ansible_play_hosts_all: playHosts,
      ansible_play_batch: playHosts,
      ansible_play_name: play?.name,
      ansible_check_mode: this.run.o.check,
      ansible_diff_mode: this.run.o.diff,
      ansible_version: { full: v, major: 2, minor: 16, revision: Number(v.split('.')[2]), string: v },
      playbook_dir: this.playDir,
      ansible_config_file: this.run.cfg.file,
      omit: OMIT,
    }
  }

  scope(h: string, play: Play | undefined, task: Task | undefined, extra: Record<string, unknown> = {}, playHosts: string[] = []): Scope {
    const st = this.state(h)
    const merged: Record<string, unknown> = {}
    // defaults de los roles < inventario < facts < vars del play < vars_files < vars del rol < bloque/tarea < set_fact/register < -e
    if (task?.role) Object.assign(merged, task.role.defaults)
    Object.assign(merged, this.invVars(h))
    if (st.facts) Object.assign(merged, { ansible_facts: st.facts, ...prefixFacts(st.facts) })
    if (play) {
      Object.assign(merged, play.vars)
      Object.assign(merged, this.playVarsFiles.get(play) ?? {})
    }
    if (task?.role) Object.assign(merged, task.role.vars, task.role.params, { role_name: task.role.name, role_path: task.role.path })
    if (task?.inherited.vars) Object.assign(merged, task.inherited.vars)
    if (task?.raw.vars) Object.assign(merged, task.raw.vars as Record<string, unknown>)
    Object.assign(merged, st.runVars, this.run.o.extraVars, extra, this.magic(h, play, playHosts))
    return lazyScope(merged)
  }

  playVarsFiles = new Map<Play, Record<string, unknown>>()

  out(s: string) {
    this.run.out(s)
  }

  /** Conecta con el equipo (una vez por corrida). */
  async conn(h: string, vars: Scope): Promise<Conn | { error: string }> {
    const st = this.state(h)
    if (st.conn) return st.conn
    if (st.unreachable) return { error: st.unreachable }
    const ctx = this.run.ctx
    const get = (k: string) => {
      const v = vars[k]
      return v === undefined || v instanceof Undef ? undefined : v
    }
    const connection = String(get('ansible_connection') ?? (h === 'localhost' || h === '127.0.0.1' ? 'local' : 'ssh'))
    const remoteUser = String(get('ansible_user') ?? get('ansible_ssh_user') ?? this.run.o.user ?? this.run.cfg.remoteUser ?? ctx.sh.user)
    if (connection === 'local') {
      st.conn = { sys: ctx.sys, user: ctx.sh.user, local: true }
      return st.conn
    }
    if (connection === 'winrm' || connection === 'psrp') {
      st.unreachable = `ntlm: HTTPConnectionPool(host='${get('ansible_host') ?? h}', port=5986): Max retries exceeded with url: /wsman (Caused by ConnectTimeoutError(<urllib3.connection.HTTPConnection object at 0x7f0b2a1c3d90>, 'Connection to ${get('ansible_host') ?? h} timed out. (connect timeout=30)'))`
      return { error: st.unreachable }
    }
    const errors: string[] = []
    const cctx: CommandContext = { ...ctx, out: () => {}, err: (s) => errors.push(s) }
    const key = get('ansible_ssh_private_key_file') ?? get('ansible_private_key_file') ?? this.run.o.privateKey ?? this.run.cfg.privateKeyFile
    const session = await connect(cctx, {
      alias: String(get('ansible_host') ?? get('ansible_ssh_host') ?? h),
      user: remoteUser,
      port: get('ansible_port') !== undefined ? Number(get('ansible_port')) : undefined,
      identities: key ? [abs(ctx, String(key))] : [],
      batch: true,
      strict: this.run.cfg.hostKeyChecking ? undefined : 'no',
    })
    if (!session) {
      const msg = errors
        .join('')
        .split('\n')
        .filter((l) => l.trim() && !/^Warning: Permanently added/.test(l) && !l.startsWith('[simulador]'))
      const shownMsg = msg.slice(-3).join('\r\n')
      st.unreachable = `Failed to connect to the host via ssh: ${shownMsg || `ssh: connect to host ${h} port 22: Connection timed out`}`
      return { error: st.unreachable }
    }
    st.conn = { sys: session.host, user: session.user, local: false }
    return st.conn
  }

  target(conn: Conn, user: string): Target {
    const sh = this.run.ctx.sh
    return {
      sys: conn.sys,
      user,
      cred: conn.sys.credFor(user),
      exec: async (cmd: string, stdin?: string) => {
        let stdout = ''
        let stderr = ''
        const { Stdin } = await import('./shell')
        const rc = await sh.onHost(conn.sys, user, () => sh.runSource(cmd, 'bash', [], { stdin: new Stdin(stdin ?? ''), out: (s: string) => (stdout += s), err: (s: string) => (stderr += s), isTTY: false }))
        return { rc, stdout, stderr }
      },
    }
  }

  /** Busca un archivo de files/ o templates/ (del rol, del playbook o relativo). */
  findSrc(task: Task, kind: 'files' | 'templates', src: string): string | undefined {
    const ctx = this.run.ctx
    if (src.startsWith('/') || src.startsWith('~')) return readFileSafe(ctx, abs(ctx, src)) !== undefined ? abs(ctx, src) : undefined
    const cands = [task.role ? `${task.role.path}/${kind}/${src}` : '', task.role ? `${task.role.path}/${src}` : '', `${task.dir}/${kind}/${src}`, `${task.dir}/${src}`, `${this.playDir}/${kind}/${src}`, `${this.playDir}/${src}`].filter(Boolean)
    return cands.find((c) => readFileSafe(ctx, normalizePath(c)) !== undefined)
  }
}

/** setup -a "filter=ansible_distribution*": solo los facts que coinciden (acepta varios separados por coma). */
function filterFacts(f: Record<string, unknown>, filter: unknown): Record<string, unknown> {
  if (filter === undefined || filter === null || filter === '') return f
  const pats = (Array.isArray(filter) ? filter : String(filter).split(',')).map((p) => new RegExp(`^${String(p).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`))
  return Object.fromEntries(Object.entries(f).filter(([k]) => pats.some((re) => re.test(k))))
}

function prefixFacts(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) out[k.startsWith('ansible_') ? k : `ansible_${k}`] = v
  return out
}

function taskLabel(t: Task): string {
  const n = t.name ?? t.action ?? 'block'
  return t.role ? `${t.role.name} : ${n}` : n
}

function runsByTags(t: Task, o: Opts): boolean {
  const tags = t.tags.map(String)
  if (o.skipTags.some((s) => tags.includes(s))) return false
  if (!o.tags.length || o.tags.includes('all')) return !tags.includes('never') || o.tags.includes('never')
  if (tags.includes('always')) return true
  if (o.tags.includes('tagged') && tags.length) return true
  if (o.tags.includes('untagged') && !tags.length) return true
  return o.tags.some((x) => tags.includes(x))
}

function renderDiff(d: FileDiff): string {
  if (typeof d.before !== 'string' || typeof d.after !== 'string') return ''
  const body = unifiedDiff(d.before, d.after)
  if (!body) return ''
  const color = (l: string) => (l.startsWith('+') ? paint('ok', l) : l.startsWith('-') ? paint('error', l) : l.startsWith('@@') ? paint('skip', l) : l)
  return [paint('error', `--- before${d.before_header ? `: ${d.before_header}` : ''}`), paint('ok', `+++ after${d.after_header ? `: ${d.after_header}` : ''}`), ...body.replace(/\n$/, '').split('\n').map(color)].join('\n') + '\n\n'
}

/**
 * Como ansible-core 2.16 (sin jinja2_native): una expresión sola que da un número vuelve como
 * texto ("{{ x | length }}" → "7"); listas, diccionarios y booleanos conservan su tipo.
 */
function ansibleTemplate(v: unknown, sc: Scope): unknown {
  if (typeof v === 'string') {
    const r = templateValue(v, sc)
    return typeof r === 'number' && v !== String(r) ? String(r) : r
  }
  if (Array.isArray(v)) return v.map((x) => ansibleTemplate(x, sc))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ansibleTemplate(x, sc)]))
  return v
}

function cleanArgs(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== OMIT).map(cleanArgs)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== OMIT).map(([k, x]) => [k, cleanArgs(x)]))
  return v
}

type Outcome = { status: 'ok' | 'changed' | 'failed' | 'skipped' | 'unreachable'; result: Result; ignored?: boolean }

async function runPlaybook(run: Run, path: string): Promise<number> {
  const ctx = run.ctx
  const o = run.o
  const playDir = path.replace(/\/[^/]+$/, '') || '/'
  const loader = new Loader(run, playDir)
  const plays = loader.playbook(path)
  if (o.syntaxCheck) {
    run.out(`\nplaybook: ${o.rest[0]}\n`)
    return 0
  }
  const ex = new Executor(run, playDir)
  const sources = o.inventories.length ? o.inventories : run.cfg.inventory
  const il = loadInventory(run, sources)
  run.inv = il.inv
  ex.invDirs = il.dirs

  const selectHosts = (play: Play): string[] => {
    const pattern = String(templateValue(play.hosts, lazyScope({ ...o.extraVars })))
    const m = matchPattern(run.inv, pattern)
    for (const u of m.unmatched) warn(run, `Could not match supplied host pattern, ignoring: ${u}`)
    let hs = m.hosts
    if (o.limit) {
      const lim = matchPattern(run.inv, o.limit)
      hs = hs.filter((h) => lim.hosts.includes(h))
    }
    return hs
  }

  if (o.listHosts || o.listTasks || o.listTags) {
    run.out(`\nplaybook: ${o.rest[0]}\n`)
    for (const p of plays) {
      const hs = selectHosts(p)
      run.out(`\n  play #${p.index} (${p.hosts}): ${p.name}\tTAGS: [${toList(p.raw.tags).join(',')}]\n`)
      if (o.listHosts) run.out(`    pattern: ['${p.hosts}']\n    hosts (${hs.length}):\n${hs.map((h) => `      ${h}\n`).join('')}`)
      if (o.listTasks) {
        run.out('    tasks:\n')
        const walk = (ts: Task[]) => {
          for (const t of ts) {
            if (!runsByTags(t, o)) continue
            if (t.kind === 'block') walk([...(t.block ?? []), ...(t.rescue ?? []), ...(t.always ?? [])])
            else run.out(`      ${taskLabel(t)}\tTAGS: [${[...new Set(t.tags.map(String))].join(', ')}]\n`)
          }
        }
        for (const s of p.sections) walk(s.tasks)
      }
      if (o.listTags) {
        const all = new Set<string>()
        const walk = (ts: Task[]) => {
          for (const t of ts) {
            t.tags.forEach((x) => all.add(String(x)))
            if (t.block) walk([...t.block, ...(t.rescue ?? []), ...(t.always ?? [])])
          }
        }
        for (const s of p.sections) walk(s.tasks)
        run.out(`      TASK TAGS: [${[...all].sort().join(', ')}]\n`)
      }
    }
    return 0
  }

  let startReached = !o.startAt
  for (const play of plays) {
    if (ex.aborted) break
    const hosts = selectHosts(play)
    run.out(banner(`PLAY [${play.name}]`))
    if (!hosts.length) {
      run.out(paint('skip', 'skipping: no hosts matched') + '\n')
      continue
    }
    // vars_files
    const vf: Record<string, unknown> = {}
    for (const f of play.varsFiles) {
      const files = Array.isArray(f) ? f : [f]
      let loaded = false
      for (const one of files) {
        const name = String(templateValue(one, lazyScope({ ...play.vars, ...o.extraVars })))
        const p = abs(ctx, name, playDir)
        if (readFileSafe(ctx, p) !== undefined) {
          Object.assign(vf, varsFile(run, p))
          loaded = true
          break
        }
      }
      if (!loaded && !Array.isArray(f)) throw new AnsibleError(`vars file ${String(f)} was not found\nCould not find file on the Ansible Controller.\nIf you are using a module and are expecting the file to exist on the remote, see the remote_src option`)
    }
    ex.playVarsFiles.set(play, vf)
    for (const h of hosts) {
      const s = ex.state(h)
      s.notified = []
    }
    const active = () => hosts.filter((h) => {
      const s = ex.state(h)
      return !s.failed && !s.unreachable && !s.ended
    })

    const gather = play.raw.gather_facts !== undefined ? truthy(play.raw.gather_facts) : run.cfg.gathering !== 'explicit'
    if (gather && !(o.tags.length && !o.tags.includes('all') && !o.tags.includes('always'))) {
      run.out(banner('TASK [Gathering Facts]'))
      for (const h of active()) {
        const sc = ex.scope(h, play, undefined, {}, hosts)
        const c = await ex.conn(h, sc)
        const st = ex.state(h)
        if ('error' in c) {
          st.stats.unreachable++
          run.out(paint('unreach', `fatal: [${h}]: UNREACHABLE! => ${pyJson({ changed: false, msg: c.error, unreachable: true })}`) + '\n')
          continue
        }
        if (!c.local && !c.sys.installed.has('python3')) {
          st.failed = true
          st.stats.failed++
          run.out(paint('error', `fatal: [${h}]: FAILED! => ${pyJson({ ansible_facts: {}, changed: false, failed_modules: { 'ansible.legacy.setup': { failed: true, module_stderr: `Shared connection to ${h} closed.\r\n`, module_stdout: '/bin/sh: 1: /usr/bin/python3: not found\r\n', msg: 'The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error', rc: 127 } }, msg: 'The following modules failed to execute: ansible.legacy.setup\n' })}`) + '\n')
          continue
        }
        st.facts = gatherFacts(c.sys, c.user)
        st.stats.ok++
        run.out(paint('ok', `ok: [${h}]`) + '\n')
      }
    }

    const runTasks = async (tasks: Task[], hs: () => string[], handlers = false): Promise<void> => {
      for (const t of tasks) {
        if (ex.aborted) return
        if (!hs().length) return
        if (!runsByTags(t, o)) continue
        if (t.kind === 'block') {
          await runBlock(t, hs)
          continue
        }
        if (!startReached) {
          if (t.name && (t.name === o.startAt || taskLabel(t) === o.startAt)) startReached = true
          else continue
        }
        await runTask(t, hs(), handlers)
      }
    }

    const runBlock = async (b: Task, hs: () => string[]) => {
      const blockHosts = hs().filter((h) => evalWhen(b, h).ok)
      if (!blockHosts.length) return
      const failedBefore = new Set(blockHosts.filter((h) => ex.state(h).failed))
      const inBlock = () => blockHosts.filter((h) => hs().includes(h) || ex.state(h).failed)
      const live = () => inBlock().filter((h) => !ex.state(h).failed && !ex.state(h).unreachable)
      await runTasks(b.block ?? [], live)
      const failedNow = blockHosts.filter((h) => ex.state(h).failed && !failedBefore.has(h))
      if (failedNow.length && b.rescue?.length) {
        for (const h of failedNow) {
          const st = ex.state(h)
          st.failed = false
          st.stats.failed--
          st.stats.rescued++
        }
        await runTasks(b.rescue, () => failedNow.filter((h) => !ex.state(h).failed && !ex.state(h).unreachable))
      }
      if (b.always?.length) {
        const all = blockHosts.filter((h) => !ex.state(h).unreachable)
        const wasFailed = all.filter((h) => ex.state(h).failed)
        for (const h of wasFailed) ex.state(h).failed = false
        await runTasks(b.always, () => all.filter((h) => !ex.state(h).failed || wasFailed.includes(h)))
        for (const h of wasFailed) ex.state(h).failed = true
      }
    }

    const evalWhen = (t: Task, h: string, extra: Record<string, unknown> = {}): { ok: boolean; error?: string } => {
      for (const c of t.when) {
        if (typeof c === 'boolean') {
          if (!c) return { ok: false }
          continue
        }
        let expr = String(c)
        if (/\{\{|\{%/.test(expr)) {
          warn(run, `conditional statements should not include jinja2 templating delimiters such as {{ }} or {% %}. Found: ${expr}`)
          try {
            expr = String(templateValue(expr, ex.scope(h, play, t, extra, hosts)))
          } catch (e) {
            return { ok: false, error: `The conditional check '${c}' failed. The error was: ${(e as Error).message}` }
          }
        }
        try {
          if (!truthy(evaluate(expr, ex.scope(h, play, t, extra, hosts)))) return { ok: false }
        } catch (e) {
          return { ok: false, error: `The conditional check '${c}' failed. The error was: error while evaluating conditional (${c}): ${(e as Error).message.replace(/^line \d+: /, '')}` }
        }
      }
      return { ok: true }
    }

    const notify = (t: Task, h: string) => {
      const names = toList(t.raw.notify).map(String)
      for (const n of names) {
        const found = play.handlers.filter((hd) => hd.name === n || (hd.role && `${hd.role.name} : ${hd.name}` === n) || toList(hd.raw.listen).map(String).includes(n))
        if (!found.length) {
          run.out(paint('error', `ERROR! The requested handler '${n}' was not found in either the main handlers list nor in the listening handlers list`) + '\n')
          ex.aborted = true
          ex.rc = 1
          return
        }
        const st = ex.state(h)
        for (const f of found) if (!st.notified.includes(f.name ?? '')) st.notified.push(f.name ?? '')
      }
    }

    const flushHandlers = async () => {
      for (const hd of play.handlers) {
        const hs = active().filter((h) => ex.state(h).notified.includes(hd.name ?? ''))
        if (!hs.length) continue
        await runTask(hd, hs, true)
        for (const h of hs) ex.state(h).notified = ex.state(h).notified.filter((n) => n !== hd.name)
      }
    }

    const runTask = async (t: Task, taskHosts: string[], isHandler: boolean) => {
      // include_tasks / include_role (dinámicos)
      if (t.short === 'include_tasks' || t.short === 'include_role') {
        for (const h of taskHosts) {
          const w = evalWhen(t, h)
          if (!w.ok) continue
          const sc = ex.scope(h, play, t, {}, hosts)
          let tasks: Task[]
          try {
            if (t.short === 'include_tasks') {
              const f = String(templateValue(t.args._raw_params ?? t.args.file, sc))
              const p = loader.findTasksFile(f, t.dir, t.role)
              const l = loadYamlFile(run, p)
              run.out(`included: ${p} for ${h}\n`)
              tasks = loader.tasks(l.data, p, l.lines, l.where, p.replace(/\/[^/]+$/, ''), t.role, t.tags)
            } else {
              const ref = loader.role(String(templateValue(t.args.name, sc)), (t.raw.vars as Record<string, unknown>) ?? {}, t)
              tasks = loader.roleTasks(ref, t.tags, String(t.args.tasks_from ?? 'main'))
              play.handlers.push(...loader.roleHandlers(ref))
            }
          } catch (e) {
            fail(h, { failed: true, msg: (e as Error).message })
            continue
          }
          await runTasks(tasks, () => [h].filter((x) => !ex.state(x).failed && !ex.state(x).unreachable))
        }
        return
      }
      if (t.short === 'meta') {
        const what = String(t.args._raw_params ?? t.args.free_form ?? '').trim()
        if (what === 'flush_handlers') {
          run.out(banner(`RUNNING HANDLER [${what}]`).replace('RUNNING HANDLER', 'TASK').replace(`[${what}]`, `[Flush handlers]`))
          await flushHandlers()
        } else if (what === 'end_play') {
          for (const h of taskHosts) ex.state(h).ended = true
        } else if (what === 'end_host') {
          for (const h of taskHosts) if (evalWhen(t, h).ok) ex.state(h).ended = true
        } else if (what === 'clear_facts') {
          for (const h of taskHosts) ex.state(h).facts = undefined
        }
        return
      }
      run.out(banner(`${isHandler ? 'RUNNING HANDLER' : 'TASK'} [${taskLabel(t)}]`))
      if (o.verbose >= 2) run.out(`task path: ${t.file}:${t.line}\n`)
      const runOnce = truthy(t.raw.run_once)
      for (const h of runOnce ? taskHosts.slice(0, 1) : taskHosts) {
        const outcome = await runOnHost(t, h)
        if (ex.aborted) return
        if (runOnce && outcome) for (const other of taskHosts.slice(1)) if (t.raw.register) ex.state(other).runVars[String(t.raw.register)] = outcome.result
      }
    }

    const fail = (h: string, r: Result) => {
      const st = ex.state(h)
      st.failed = true
      st.stats.failed++
      run.out(paint('error', `fatal: [${h}]: FAILED! => ${pyJson(shown({ changed: false, ...r }))}`) + '\n')
    }

    const runOnHost = async (t: Task, h: string): Promise<Outcome | undefined> => {
      const st = ex.state(h)
      // when (sin loop: antes de nada)
      const hasLoop = t.raw.loop !== undefined || Object.keys(t.raw).some((k) => k.startsWith('with_'))
      if (!hasLoop) {
        const w = evalWhen(t, h)
        if (w.error) {
          fail(h, { failed: true, msg: `${w.error}\n\n${errorContext(t.file, t.lines, t.line, t.col)}` })
          return
        }
        if (!w.ok) {
          st.stats.skipped++
          run.out(paint('skip', `skipping: [${h}]`) + '\n')
          return { status: 'skipped', result: { changed: false, skipped: true, skip_reason: 'Conditional result was False' } }
        }
      }
      // items del loop
      let items: unknown[] | undefined
      const lc = (t.raw.loop_control as Record<string, unknown>) ?? {}
      const loopVar = String(lc.loop_var ?? 'item')
      if (hasLoop) {
        try {
          const sc = ex.scope(h, play, t, {}, hosts)
          if (t.raw.loop !== undefined) items = templateValue(t.raw.loop, sc) as unknown[]
          else if (t.raw.with_items !== undefined) items = (toArrayLoose(templateValue(t.raw.with_items, sc)) as unknown[]).flatMap((x) => (Array.isArray(x) ? x : [x]))
          else if (t.raw.with_list !== undefined) items = toArrayLoose(templateValue(t.raw.with_list, sc))
          else if (t.raw.with_dict !== undefined) {
            const d = templateValue(t.raw.with_dict, sc) as Record<string, unknown>
            items = Object.entries(d ?? {}).map(([key, value]) => ({ key, value }))
          } else if (t.raw.with_sequence !== undefined) {
            const kv = splitKv(String(t.raw.with_sequence))
            const start = Number(kv.start ?? 1)
            const end = Number(kv.end ?? kv.count ?? 0)
            items = []
            for (let i = start; i <= end; i += Number(kv.stride ?? 1)) items.push(kv.format ? kv.format.replace(/^['"]|['"]$/g, '').replace(/%\d*d/, String(i)) : String(i))
          } else items = []
          if (!Array.isArray(items)) {
            fail(h, { failed: true, msg: `Invalid data passed to 'loop', it requires a list, got this instead: ${String(items)}. Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.` })
            return
          }
        } catch (e) {
          fail(h, { failed: true, msg: `The task includes an option with an undefined variable. The error was: ${(e as Error).message}\n\n${errorContext(t.file, t.lines, t.line, t.col)}` })
          return
        }
      }

      if (!items) {
        const r = await execOnce(t, h, {})
        return finish(t, h, r)
      }
      // loop
      const results: Result[] = []
      let anyChanged = false
      let anyFailed = false
      let allSkipped = items.length > 0
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const extra: Record<string, unknown> = { [loopVar]: item, ansible_loop_var: loopVar, ...(lc.index_var ? { [String(lc.index_var)]: i } : {}), ansible_loop: { index: i + 1, index0: i, first: i === 0, last: i === items.length - 1, length: items.length } }
        const label = isNoLog(t, h) ? 'None' : lc.label !== undefined ? pyLabel(safeTemplate(lc.label, ex.scope(h, play, t, extra, hosts))) : pyLabel(item)
        const w = evalWhen(t, h, extra)
        if (w.error) {
          fail(h, { failed: true, msg: w.error })
          return
        }
        if (!w.ok) {
          results.push({ changed: false, skipped: true, skip_reason: 'Conditional result was False', [loopVar]: item, ansible_loop_var: loopVar })
          run.out(paint('skip', `skipping: [${h}] => (item=${label}) `) + '\n')
          continue
        }
        allSkipped = false
        const r = await execOnce(t, h, extra)
        const res0 = { ...r.result, [loopVar]: item, ansible_loop_var: loopVar }
        results.push(res0)
        const res: Result = isNoLog(t, h) ? { censored: CENSORED, changed: !!res0.changed } : res0
        if (r.status === 'unreachable') return finish(t, h, r)
        const diff = o.diff && res.changed && res.diff ? (Array.isArray(res.diff) ? res.diff : [res.diff]).map(renderDiff).join('') : ''
        if (diff) run.out(diff)
        if (r.status === 'failed') {
          anyFailed = true
          run.out(paint('error', `failed: [${h}] (item=${label}) => ${pyJson(shown(res))}`) + '\n')
        } else if (r.status === 'changed') {
          anyChanged = true
          run.out(paint('changed', `changed: [${h}] => (item=${label})${o.verbose ? ` => ${pyJson(shown(res))}` : ''}`) + '\n')
        } else if (r.status === 'skipped') run.out(paint('skip', `skipping: [${h}] => (item=${label}) `) + '\n')
        else if (t.short === 'debug') run.out(paint('ok', `ok: [${h}] => (item=${label}) => ${pyJson(shown(res), 4)}`) + '\n')
        else run.out(paint('ok', `ok: [${h}] => (item=${label})${o.verbose ? ` => ${pyJson(shown(res))}` : ''}`) + '\n')
      }
      const agg: Result = { changed: anyChanged, results, msg: anyFailed ? 'One or more items failed' : 'All items completed', ...(anyFailed ? { failed: true } : {}), ...(allSkipped ? { skipped: true } : {}) }
      if (t.raw.register) st.runVars[String(t.raw.register)] = agg
      if (allSkipped) {
        st.stats.skipped++
        if (!items.length) run.out(paint('skip', `skipping: [${h}]`) + '\n')
        return { status: 'skipped', result: agg }
      }
      if (anyFailed) {
        if (truthy(templateMaybe(t.raw.ignore_errors ?? t.inherited.ignore_errors, h, t))) {
          st.stats.ignored++
          run.out(paint('skip', '...ignoring') + '\n')
          return { status: 'failed', result: agg, ignored: true }
        }
        st.failed = true
        st.stats.failed++
        return { status: 'failed', result: agg }
      }
      if (anyChanged) {
        st.stats.changed++
        st.stats.ok++
        notify(t, h)
        return { status: 'changed', result: agg }
      }
      st.stats.ok++
      return { status: 'ok', result: agg }
    }

    const templateMaybe = (v: unknown, h: string, t: Task) => {
      if (v === undefined) return false
      try {
        return templateValue(v, ex.scope(h, play, t, {}, hosts))
      } catch {
        return v
      }
    }

    const safeTemplate = (v: unknown, sc: Scope) => {
      try {
        return templateValue(v, sc)
      } catch {
        return v
      }
    }

    const CENSORED = "the output has been hidden due to the fact that 'no_log: true' was specified for this result"
    const isNoLog = (t: Task, h: string) => truthy(templateMaybe(t.raw.no_log ?? t.inherited.no_log ?? play.raw.no_log, h, t))
    const finish = (t: Task, h: string, r0: Outcome): Outcome => {
      const st = ex.state(h)
      const noLog = isNoLog(t, h)
      if (t.raw.register) st.runVars[String(t.raw.register)] = shownForRegister(r0.result)
      const r: Outcome = noLog ? { ...r0, result: { censored: CENSORED, changed: !!r0.result.changed, ...(r0.result.failed ? { failed: true } : {}), ...(r0.result.skipped ? { skipped: true } : {}) } } : r0
      const res = r.result
      if (r.status === 'unreachable') {
        st.unreachable ??= String(res.msg)
        st.stats.unreachable++
        run.out(paint('unreach', `fatal: [${h}]: UNREACHABLE! => ${pyJson(shown(res))}`) + '\n')
        return r
      }
      const diff = o.diff && res.changed && res.diff ? (Array.isArray(res.diff) ? res.diff : [res.diff]).map(renderDiff).join('') : ''
      if (diff) run.out(diff)
      if (r.status === 'failed') {
        if (truthy(templateMaybe(t.raw.ignore_errors ?? t.inherited.ignore_errors, h, t))) {
          st.stats.ignored++
          st.stats.ok++
          if (res.changed) st.stats.changed++
          run.out(paint('error', `fatal: [${h}]: FAILED! => ${pyJson(shown(res))}`) + '\n' + paint('skip', '...ignoring') + '\n')
          return { ...r, ignored: true }
        }
        st.failed = true
        st.stats.failed++
        run.out(paint('error', `fatal: [${h}]: FAILED! => ${pyJson(shown(res))}`) + '\n')
        return r
      }
      if (r.status === 'skipped') {
        st.stats.skipped++
        run.out(paint('skip', `skipping: [${h}]${o.verbose ? ` => ${pyJson(shown(res))}` : ''}`) + '\n')
        return r
      }
      st.stats.ok++
      if (r.status === 'changed') st.stats.changed++
      const verbose = o.verbose > 0 || t.short === 'debug'
      const color = r.status === 'changed' ? 'changed' : 'ok'
      if (t.short === 'debug') run.out(paint(color, `${r.status}: [${h}] => ${pyJson(debugShown(res), 4)}`) + '\n')
      else run.out(paint(color, `${r.status}: [${h}]${verbose ? ` => ${pyJson(shown(res))}` : ''}`) + '\n')
      if (r.status === 'changed') notify(t, h)
      return r
    }

    const execOnce = async (t: Task, h: string, extra: Record<string, unknown>): Promise<Outcome> => {
      const st = ex.state(h)
      const sc = ex.scope(h, play, t, extra, hosts)
      let args: Record<string, unknown>
      try {
        args = cleanArgs(ansibleTemplate(t.args, sc)) as Record<string, unknown>
      } catch (e) {
        const m = (e as Error).message.replace(/^line \d+: /, '')
        return { status: 'failed', result: { failed: true, msg: `The task includes an option with an undefined variable. The error was: ${m}. ${m}\n\n${errorContext(t.file, t.lines, t.line, t.col)}` } }
      }
      const short = t.short!
      let result: Result
      const check = (() => {
        const cm = t.raw.check_mode ?? t.inherited.check_mode ?? play.raw.check_mode
        return cm === undefined ? o.check : truthy(templateMaybe(cm, h, t))
      })()
      // acciones locales
      if (short === 'debug') {
        if (args.var !== undefined) {
          const name = String(args.var)
          let v: unknown
          try {
            v = evaluate(name, sc)
          } catch {
            v = new Undef(name)
          }
          result = { changed: false, [name]: v instanceof Undef ? 'VARIABLE IS NOT DEFINED!' : v }
        } else result = { changed: false, msg: (args.msg as string | undefined) ?? 'Hello world!' }
        const verbosity = Number(args.verbosity ?? 0)
        if (verbosity > o.verbose) return { status: 'skipped', result: { skipped_reason: 'Verbosity threshold not met.', skipped: true, changed: false } }
      } else if (short === 'set_fact') {
        const facts = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'cacheable'))
        Object.assign(st.runVars, facts)
        result = { changed: false, ansible_facts: facts }
      } else if (short === 'assert') {
        const that = toList(args.that)
        let failedOn: string | undefined
        for (const c of that) {
          try {
            if (!truthy(evaluate(String(c).replace(/^\{\{\s*|\s*\}\}$/g, ''), sc))) {
              failedOn = String(c)
              break
            }
          } catch (e) {
            return { status: 'failed', result: { failed: true, msg: `The conditional check '${c}' failed. The error was: error while evaluating conditional (${c}): ${(e as Error).message}` } }
          }
        }
        if (failedOn) result = { failed: true, changed: false, assertion: failedOn, evaluated_to: false, msg: (args.fail_msg as string | undefined) ?? (args.msg as string | undefined) ?? 'Assertion failed' }
        else result = { changed: false, msg: (args.success_msg as string | undefined) ?? 'All assertions passed' }
      } else if (short === 'fail') {
        result = { failed: true, changed: false, msg: (args.msg as string | undefined) ?? 'Failed as requested from task' }
      } else if (short === 'pause') {
        result = { changed: false, start: new Date().toISOString(), stop: new Date().toISOString(), delta: Number(args.seconds ?? 0), echo: true, user_input: '', stdout: `Paused for ${args.seconds ?? args.minutes ?? 0} ${args.minutes ? 'minutes' : 'seconds'}` }
      } else if (short === 'include_vars') {
        const f = String(args._raw_params ?? args.file)
        const p = ex.findSrc(t, 'files', f) ?? abs(ctx, f, t.dir)
        try {
          const vars = varsFile(run, ex.findSrc({ ...t, dir: t.dir.replace(/\/tasks$/, '/vars') }, 'files', f) ?? p)
          Object.assign(st.runVars, args.name ? { [String(args.name)]: vars } : vars)
          result = { changed: false, ansible_facts: vars, ansible_included_var_files: [p] }
        } catch (e) {
          result = { failed: true, changed: false, msg: (e as Error).message }
        }
      } else if (short === 'setup' || short === 'gather_facts' || short === 'package_facts' || short === 'service_facts') {
        const c = await ex.conn(h, sc)
        if ('error' in c) return { status: 'unreachable', result: { changed: false, msg: c.error, unreachable: true } }
        if (short === 'package_facts') {
          const pk: Record<string, unknown> = {}
          for (const p of c.sys.installed) pk[p] = [{ name: p, version: c.sys.catalog[p]?.version ?? '1.0', source: c.sys.distro === 'ubuntu' ? 'apt' : 'rpm' }]
          st.facts = { ...(st.facts ?? {}), packages: pk }
          result = { changed: false, ansible_facts: { packages: pk } }
        } else if (short === 'service_facts') {
          const sv: Record<string, unknown> = {}
          for (const [n, s] of c.sys.services) sv[`${n}.service`] = { name: `${n}.service`, state: s.active ? 'running' : s.failed ? 'failed' : 'stopped', status: s.enabled ? 'enabled' : 'disabled', source: 'systemd' }
          st.facts = { ...(st.facts ?? {}), services: sv }
          result = { changed: false, ansible_facts: { services: sv } }
        } else {
          st.facts = gatherFacts(c.sys, c.user)
          result = { changed: false, ansible_facts: filterFacts(prefixFacts(st.facts), args.filter) }
        }
      } else if (short === 'reboot') {
        result = check ? { changed: true, elapsed: 0, rebooted: true } : { changed: true, elapsed: 42, rebooted: true }
      } else if (short === 'add_host' || short === 'group_by' || short === 'set_stats') {
        result = { changed: false }
      } else if (short in REMOTE_MODULES) {
        const delegate = t.raw.delegate_to ?? t.inherited.delegate_to
        const targetHost = delegate !== undefined ? String(templateValue(delegate, sc)) : h
        const tsc = targetHost === h ? sc : ex.scope(targetHost, play, t, extra, hosts)
        const c = await ex.conn(targetHost, tsc)
        if ('error' in c) return { status: 'unreachable', result: { changed: false, msg: c.error, unreachable: true } }
        if (!c.local && !c.sys.installed.has('python3') && short !== 'raw') {
          return { status: 'failed', result: { failed: true, changed: false, module_stderr: `Shared connection to ${targetHost} closed.\r\n`, module_stdout: '/bin/sh: 1: /usr/bin/python3: not found\r\n', msg: 'The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error', rc: 127 } }
        }
        // become
        const becomeRaw = t.raw.become ?? t.inherited.become ?? play.raw.become ?? (o.become || run.cfg.become)
        const become = truthy(templateMaybe(becomeRaw, h, t)) || o.become
        const becomeUser = String(templateMaybe(t.raw.become_user ?? t.inherited.become_user ?? play.raw.become_user ?? o.becomeUser ?? run.cfg.becomeUser, h, t) || 'root')
        let user = c.user
        if (become && becomeUser !== c.user) {
          const need = sudoNeedsPassword(c.sys, c.user)
          const askPass = o.askBecome || run.cfg.becomeAskPass
          if (need === 'none') {
            return { status: 'failed', result: askPass ? { failed: true, changed: false, module_stderr: `${c.user} is not in the sudoers file.  This incident will be reported.\n`, module_stdout: '', msg: 'MODULE FAILURE\nSee stdout/stderr for the exact error', rc: 1 } : { failed: true, msg: 'Missing sudo password' } }
          }
          if (need === 'passwd' && !askPass) return { status: 'failed', result: { failed: true, msg: 'Missing sudo password' } }
          user = becomeUser
        }
        const target = ex.target(c, user)
        try {
          result = await REMOTE_MODULES[short]({
            args,
            t: target,
            check,
            findSrc: (kind, src) => ex.findSrc(t, kind, src),
            readControl: (p) => unvault(run, readControl(run, p), p),
            render: (text) => render(text, ex.scope(h, play, t, { ...extra, ansible_managed: 'Ansible managed', template_host: ctx.sys.hostname, template_uid: ctx.sh.user }, hosts)),
            vars: {},
            inventoryHostname: h,
            facts: () => st.facts ?? {},
          })
        } catch (e) {
          if (e instanceof ModuleArgError) result = { failed: true, changed: false, msg: e.message }
          else result = { failed: true, changed: false, msg: `MODULE FAILURE: ${(e as Error).message}` }
        }
        if (result.ansible_facts && typeof result.ansible_facts === 'object') st.facts = { ...(st.facts ?? {}), ...(result.ansible_facts as Record<string, unknown>) }
      } else {
        result = { failed: true, changed: false, msg: `El simulador no ejecuta ${t.action} (se puede escribir y validar, pero no correr acá).` }
      }
      // changed_when / failed_when
      const regName = t.raw.register ? String(t.raw.register) : undefined
      const evalWith = (cond: unknown): boolean => {
        const conds = Array.isArray(cond) ? cond : [cond]
        const sc2 = ex.scope(h, play, t, { ...extra, ...(regName ? { [regName]: result } : {}), result }, hosts)
        return conds.every((c) => (typeof c === 'boolean' ? c : truthy(evaluate(String(c).replace(/^\{\{\s*|\s*\}\}$/g, ''), sc2))))
      }
      try {
        if (t.raw.failed_when !== undefined && !result.skipped) {
          const f = evalWith(t.raw.failed_when)
          result = { ...result, failed: f, failed_when_result: f }
          if (!f && result.msg === 'non-zero return code') result.msg = ''
        }
        if (t.raw.changed_when !== undefined && !result.skipped && !result.failed) result = { ...result, changed: evalWith(t.raw.changed_when) }
      } catch (e) {
        result = { failed: true, changed: false, msg: `The conditional check failed. The error was: ${(e as Error).message}` }
      }
      // until / retries
      if (t.raw.until !== undefined && !result.skipped) {
        const retries = Number(t.raw.retries ?? 3)
        let attempts = 1
        while (!evalWith(t.raw.until) && attempts <= retries) {
          run.out(paint('error', `FAILED - RETRYING: [${h}]: ${taskLabel(t)} (${retries - attempts + 1} retries left).`) + '\n')
          attempts++
        }
        if (!evalWith(t.raw.until)) result = { ...result, failed: true, attempts }
        else result = { ...result, attempts }
      }
      const status: Outcome['status'] = result.failed ? 'failed' : result.skipped ? 'skipped' : result.changed ? 'changed' : 'ok'
      return { status, result }
    }

    try {
      for (const sec of play.sections) {
        await runTasks(sec.tasks, active)
        if (ex.aborted) break
        if (sec.name === 'pre_tasks' || sec.name === 'tasks' || sec.name === 'post_tasks') {
          const any = active().some((h) => ex.state(h).notified.length)
          if (any) await flushHandlers()
        }
      }
    } catch (e) {
      if (e instanceof AnsibleError) throw e
      throw e
    }
    if (!active().length && hosts.some((h) => ex.state(h).failed || ex.state(h).unreachable) && !ex.aborted) run.out(banner('NO MORE HOSTS LEFT'))
  }

  if (ex.aborted) return ex.rc
  // PLAY RECAP
  run.out(banner('PLAY RECAP'))
  let anyFailed = false
  let anyUnreach = false
  for (const [h, st] of [...ex.hosts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const s = st.stats
    if (s.failed) anyFailed = true
    if (s.unreachable) anyUnreach = true
    const hc = s.failed || s.unreachable ? 'error' : s.changed ? 'changed' : 'ok'
    const f = (label: string, n: number, c: keyof typeof COLOR) => {
      const text = `${label}=${String(n).padEnd(4)}`
      return n ? `${COLOR[c]}${label}=${n}${COLOR.reset}${' '.repeat(Math.max(0, 4 - String(n).length))}` : text
    }
    run.out(`${paint(hc, h.padEnd(26))} : ${f('ok', s.ok, 'ok')} ${f('changed', s.changed, 'changed')} ${f('unreachable', s.unreachable, 'unreach')} ${f('failed', s.failed, 'error')} ${f('skipped', s.skipped, 'skip')} ${f('rescued', s.rescued, 'ok')} ${f('ignored', s.ignored, 'warn')}\n`)
  }
  run.out('\n')
  return anyFailed ? 2 : anyUnreach ? 4 : 0
}

function shownForRegister(r: Result): Result {
  const out = { ...r }
  delete out.diff
  if (out.failed === undefined) out.failed = false
  return out
}

function debugShown(r: Result): Record<string, unknown> {
  const out = shown(r)
  delete out.changed
  return out
}

function pyLabel(v: unknown): string {
  if (typeof v === 'string') return v
  return pyRepr(v)
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `'${k}': ${pyRepr(x)}`)
    .join(', ')}}`
}

function toArrayLoose(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v === null || v === undefined || v === '') return []
  return [v]
}

// ---------------------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------------------

function notInstalled(ctx: CommandContext, name: string): number {
  ctx.err(`bash: ${name}: command not found\n`)
  return 127
}

function setup(ctx: CommandContext, args: string[]): { run: Run; error?: number } {
  const cfg = loadCfg(ctx)
  const o = parseOpts(ctx, args)
  const run: Run = { ctx, cfg, o, inv: emptyInventory(), warnings: new Set(), out: ctx.out }
  if (o.error) {
    ctx.err(`usage: ${ctx.name} [-h] [--version] [-v] ...\n${ctx.name}: error: ${o.error}\n`)
    return { run, error: o.error.includes('sshpass') ? 1 : 2 }
  }
  return { run }
}

function handleError(ctx: CommandContext, e: unknown): number {
  if (e instanceof AnsibleError || e instanceof InventoryError || e instanceof VaultError) {
    ctx.out(paint('error', `ERROR! ${e.message}`) + '\n')
    return e instanceof VaultError ? 1 : 1
  }
  if (e instanceof JinjaError) {
    ctx.out(paint('error', `ERROR! ${e.message}`) + '\n')
    return 1
  }
  throw e
}

register('ansible-playbook', {
  usage: 'ansible-playbook [-i INVENTARIO] [--check] [--diff] [-v] [-l LIMITE] [-t TAGS] [-e VAR=VALOR] [-K] playbook.yml',
  summary: '  -i inventario  -C/--check modo de prueba  -D/--diff mostrar cambios  -l limitar equipos\n  -t/--tags  --skip-tags  -e variables extra  -b/--become  -K pedir la contraseña de sudo\n  --syntax-check  --list-hosts  --list-tasks  --list-tags  --vault-password-file  -J/--ask-vault-pass  -v, -vv, -vvv',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-playbook')
    const { run, error } = setup(ctx, ctx.args)
    if (error !== undefined) return error
    const o = run.o
    if (o.version) {
      ctx.out(versionText(ctx, 'ansible-playbook', run.cfg))
      return 0
    }
    if (o.help || !o.rest.length) {
      if (!o.help) {
        ctx.err('usage: ansible-playbook [-h] [--version] [-v] [--private-key PRIVATE_KEY_FILE]\n                        [-u REMOTE_USER] [-c CONNECTION] [-T TIMEOUT]\n                        [-b] [--become-method BECOME_METHOD] [--become-user BECOME_USER]\n                        [-K] [-t TAGS] [--skip-tags SKIP_TAGS] [-C] [-D] [-i INVENTORY]\n                        [--list-hosts] [-l SUBSET] [-e EXTRA_VARS] [--vault-id VAULT_IDS]\n                        [-J | --vault-password-file VAULT_PASSWORD_FILES] [-f FORKS]\n                        [--syntax-check] [--list-tasks] [--list-tags] [--step]\n                        [--start-at-task START_AT_TASK]\n                        playbook [playbook ...]\nansible-playbook: error: the following arguments are required: playbook\n')
        return 2
      }
      ctx.out(`usage: ${this.usage}\n${this.summary}\n`)
      return 0
    }
    if (o.askBecome) {
      ctx.out('BECOME password: ')
      ctx.stdin.readLine()
      ctx.out('\n')
    }
    try {
      run.vaultPass = getVaultPass(ctx, run.cfg, o)
      if (o.verbose) ctx.out(`ansible-playbook [core ${CORE_VERSION[ctx.sys.distro]}]\n${run.cfg.file ? `Using ${run.cfg.file} as config file` : 'No config file found; using defaults'}\n`)
      let rc = 0
      for (const p of o.rest) {
        const path = abs(ctx, p)
        if (readFileSafe(ctx, path) === undefined) {
          ctx.out(paint('error', `ERROR! the playbook: ${p} could not be found`) + '\n')
          return 1
        }
        rc = Math.max(rc, await runPlaybook(run, path))
      }
      return rc
    } catch (e) {
      return handleError(ctx, e)
    }
  },
})

register('ansible', {
  usage: 'ansible PATRÓN [-i INVENTARIO] [-m MÓDULO] [-a ARGUMENTOS] [-b] [-K] [-o] [-v]',
  summary: '  -m módulo (por defecto command)  -a argumentos  -b/--become  -K pedir la contraseña de sudo\n  -i inventario  -l limitar  -o una línea por equipo  -C modo de prueba  --list-hosts  --version',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible')
    const { run, error } = setup(ctx, ctx.args)
    if (error !== undefined) return error
    const o = run.o
    if (o.version) {
      ctx.out(versionText(ctx, 'ansible', run.cfg))
      return 0
    }
    if (o.help || !o.rest.length) {
      if (o.help) {
        ctx.out(`usage: ${this.usage}\n${this.summary}\n`)
        return 0
      }
      ctx.err('usage: ansible [-h] [--version] [-v] [-b] [--become-method BECOME_METHOD]\n               [--become-user BECOME_USER] [-K] [-i INVENTORY] [--list-hosts]\n               [-l SUBSET] [-P POLL_INTERVAL] [-B SECONDS] [-o] [-t TREE]\n               [--private-key PRIVATE_KEY_FILE] [-u REMOTE_USER] [-C] [-D]\n               [-e EXTRA_VARS] [-f FORKS] [-M MODULE_PATH] [-a MODULE_ARGS] [-m MODULE_NAME]\n               pattern\nansible: error: the following arguments are required: pattern\n')
      return 2
    }
    if (o.askBecome) {
      ctx.out('BECOME password: ')
      ctx.stdin.readLine()
      ctx.out('\n')
    }
    try {
      run.vaultPass = getVaultPass(ctx, run.cfg, o)
      const il = loadInventory(run, o.inventories.length ? o.inventories : run.cfg.inventory)
      run.inv = il.inv
      const m = matchPattern(run.inv, o.rest[0])
      for (const u of m.unmatched) warn(run, `Could not match supplied host pattern, ignoring: ${u}`)
      let hosts = m.hosts
      if (o.limit) {
        const lim = matchPattern(run.inv, o.limit)
        hosts = hosts.filter((h) => lim.hosts.includes(h))
      }
      if (o.listHosts) {
        ctx.out(`  hosts (${hosts.length}):\n${hosts.map((h) => `    ${h}\n`).join('')}`)
        return 0
      }
      if (!hosts.length) {
        warn(run, run.inv.hosts.size ? 'No hosts matched, nothing to do' : 'provided hosts list is empty, only localhost is available. Note that the implicit localhost does not match \'all\'')
        return 0
      }
      const moduleName = o.module ?? 'command'
      const res = resolveAction(moduleName)
      if (!res || (res.collection !== 'ansible.builtin' && !installedCollections(run).has(res.collection))) {
        ctx.out(paint('error', `ERROR! couldn't resolve module/action '${moduleName}'. This often indicates a misspelling, missing collection, or incorrect module path.`) + '\n')
        return 1
      }
      const rawArgs = o.moduleArgs ?? ''
      const isFree = ['command', 'shell', 'raw'].includes(res.short)
      if (isFree && !rawArgs.trim()) {
        ctx.out(paint('error', `ERROR! No argument passed to ${res.short} module`) + '\n')
        return 1
      }
      // Un play de una tarea, como hace ansible por dentro.
      const ex = new Executor(run, ctx.sh.cwd)
      ex.invDirs = il.dirs
      let rc = 0
      const discovered = new Set<string>()
      for (const h of hosts) {
        const sc = ex.scope(h, undefined, undefined, {}, hosts)
        let args: Record<string, unknown>
        try {
          args = isFree ? { _raw_params: String(templateValue(rawArgs, sc)) } : (cleanArgs(templateValue(Object.fromEntries(Object.entries(splitKv(rawArgs)).map(([k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')])), sc)) as Record<string, unknown>)
        } catch (e) {
          ctx.out(paint('error', `${h} | FAILED! => ${pyJson({ changed: false, msg: `The task includes an option with an undefined variable. The error was: ${(e as Error).message}` }, 4)}`) + '\n')
          rc = 2
          continue
        }
        const c = await ex.conn(h, sc)
        if ('error' in c) {
          ctx.out(paint('unreach', `${h} | UNREACHABLE! => ${o.oneLine ? pyJson({ changed: false, msg: c.error, unreachable: true }) : pyJson({ changed: false, msg: c.error, unreachable: true }, 4)}`) + '\n')
          rc = Math.max(rc, 4)
          continue
        }
        let result: Result
        let user = c.user
        if (o.become || run.cfg.become) {
          const need = sudoNeedsPassword(c.sys, c.user)
          if (need === 'none' || (need === 'passwd' && !o.askBecome && !run.cfg.becomeAskPass)) {
            ctx.out(paint('error', `${h} | FAILED! => ${pyJson({ msg: need === 'none' && o.askBecome ? `${c.user} is not in the sudoers file.  This incident will be reported.` : 'Missing sudo password' }, 4)}`) + '\n')
            rc = 2
            continue
          }
          user = o.becomeUser ?? run.cfg.becomeUser
        }
        if (res.short === 'setup') result = { changed: false, ansible_facts: filterFacts(prefixFacts(gatherFacts(c.sys, c.user)), args.filter) }
        else if (res.short === 'debug') result = { changed: false, msg: (args.msg as string | undefined) ?? 'Hello world!' }
        else if (!(res.short in REMOTE_MODULES)) result = { failed: true, changed: false, msg: `${moduleName} no se puede usar en un comando ad hoc del simulador` }
        else if (!c.local && !c.sys.installed.has('python3') && res.short !== 'raw') {
          result = { failed: true, changed: false, module_stderr: `Shared connection to ${h} closed.\r\n`, module_stdout: '/bin/sh: 1: /usr/bin/python3: not found\r\n', msg: 'The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error', rc: 127 }
        } else {
          try {
            result = await REMOTE_MODULES[res.short]({ args, t: ex.target(c, user), check: o.check, findSrc: (_k, src) => (readFileSafe(ctx, abs(ctx, src)) !== undefined ? abs(ctx, src) : undefined), readControl: (p) => readControl(run, p), render: (text) => render(text, ex.scope(h, undefined, undefined, {}, hosts)), vars: {}, inventoryHostname: h, facts: () => ({}) })
          } catch (e) {
            result = { failed: true, changed: false, msg: (e as Error).message }
          }
        }
        if (!discovered.has(h) && res.short !== 'setup') {
          result = { ansible_facts: { discovered_interpreter_python: '/usr/bin/python3' }, ...result }
          discovered.add(h)
        }
        if (o.diff && result.changed && result.diff) ctx.out((Array.isArray(result.diff) ? result.diff : [result.diff]).map(renderDiff).join(''))
        const state = result.failed ? 'FAILED' : result.changed ? 'CHANGED' : 'SUCCESS'
        const color = result.failed ? 'error' : result.changed ? 'changed' : 'ok'
        if (result.failed) rc = Math.max(rc, 2)
        if (isFree && !result.skipped && (result.rc !== undefined || result.failed)) {
          const out = `${result.stdout ?? ''}${result.stderr ? `${result.stdout ? '\n' : ''}${result.stderr}` : ''}`
          if (o.oneLine) ctx.out(paint(color, `${h} | ${state} | rc=${result.rc ?? 1} | (stdout) ${String(result.stdout ?? '').replace(/\n/g, '\\n')}`) + '\n')
          else ctx.out(paint(color, `${h} | ${state} | rc=${result.rc ?? 1} >>\n${out}${out && !out.endsWith('\n') ? '\n' : ''}${result.failed && result.msg ? `${result.msg}` : ''}`) + (result.failed && result.msg ? '\n' : ''))
        } else {
          const body = shown(result)
          ctx.out(paint(color, `${h} | ${state}${result.failed ? '!' : ''} => ${o.oneLine ? pyJson(body).replace(/, "/g, ',"') : pyJson(body, 4)}`) + '\n')
        }
      }
      return rc
    } catch (e) {
      return handleError(ctx, e)
    }
  },
})

register('ansible-inventory', {
  usage: 'ansible-inventory [-i INVENTARIO] (--list | --graph [GRUPO] | --host EQUIPO) [--vars] [-y]',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-inventory')
    const args = [...ctx.args]
    let mode: 'list' | 'graph' | 'host' | undefined
    let target: string | undefined
    let vars = false
    let yaml = false
    const rest: string[] = []
    while (args.length) {
      const a = args.shift()!
      if (a === '--list') mode = 'list'
      else if (a === '--graph') {
        mode = 'graph'
        if (args[0] && !args[0].startsWith('-')) target = args.shift()
      } else if (a === '--host') {
        mode = 'host'
        target = args.shift()
      } else if (a === '--vars') vars = true
      else if (a === '-y' || a === '--yaml') yaml = true
      else rest.push(a)
    }
    const { run, error } = setup(ctx, rest)
    if (error !== undefined) return error
    if (!mode) {
      ctx.err('usage: ansible-inventory [-h] [--version] [-v] [-i INVENTORY] [--vault-id VAULT_IDS]\n                         [-J | --vault-password-file VAULT_PASSWORD_FILES]\n                         [--playbook-dir BASEDIR] [-e EXTRA_VARS] [--list]\n                         [--host HOST] [--graph] [-y] [--toml] [--vars]\n                         [--export] [--output OUTPUT_FILE]\n                         [host|group]\nansible-inventory: error: No action selected, at least one of --host, --graph or --list needs to be specified.\n')
      return 2
    }
    try {
      run.vaultPass = getVaultPass(ctx, run.cfg, run.o)
      const il = loadInventory(run, run.o.inventories.length ? run.o.inventories : run.cfg.inventory)
      run.inv = il.inv
      const ex = new Executor(run, '')
      ex.invDirs = il.dirs
      const inv = run.inv
      if (mode === 'graph') {
        const lines: string[] = []
        const walk = (g: string, depth: number) => {
          const gr = inv.groups.get(g)
          if (!gr) return
          lines.push(`${depth ? '  |'.repeat(depth - 1) + '  |--' : ''}@${g}:`)
          for (const c of gr.children) walk(c, depth + 1)
          for (const h of g === 'all' ? [] : gr.hosts) {
            lines.push(`${'  |'.repeat(depth)}  |--${h}`)
            if (vars) for (const [k, v] of Object.entries(inv.hosts.get(h) ?? {})) lines.push(`${'  |'.repeat(depth + 1)}  |--{${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}}`)
          }
          if (vars) for (const [k, v] of Object.entries(gr.vars)) lines.push(`${'  |'.repeat(depth)}  |--{${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}}`)
        }
        const start = target ?? 'all'
        if (!inv.groups.has(start)) {
          ctx.out(paint('error', `ERROR! Either "${start}" is not a group, or it is not in the inventory`) + '\n')
          return 1
        }
        walk(start, 0)
        ctx.out(lines.join('\n') + '\n')
        return 0
      }
      if (mode === 'host') {
        if (!target || !inv.hosts.has(target)) {
          ctx.out(paint('error', `ERROR! You must pass a single valid host to --host parameter`) + '\n')
          return 1
        }
        const v = ex.invVars(target)
        ctx.out(yaml ? toYaml(v) : pyJson(v, 4) + '\n')
        return 0
      }
      const out: Record<string, unknown> = { _meta: { hostvars: Object.fromEntries([...inv.hosts.keys()].map((h) => [h, ex.invVars(h)]).filter(([, v]) => Object.keys(v as object).length)) } }
      for (const [g, gr] of inv.groups) {
        const e: Record<string, unknown> = {}
        if (gr.children.length) e.children = gr.children
        if (gr.hosts.length) e.hosts = gr.hosts
        if (Object.keys(e).length) out[g] = e
      }
      ctx.out(yaml ? toYaml(out) : jsonInOrder(out, 4) + '\n')
      return 0
    } catch (e) {
      return handleError(ctx, e)
    }
  },
})

function jsonInOrder(v: unknown, indent: number): string {
  return JSON.stringify(v, null, indent)
}

function toYaml(v: unknown, level = 0): string {
  const pad = '  '.repeat(level)
  if (v === null || v === undefined) return 'null\n'
  if (typeof v !== 'object') return `${typeof v === 'string' ? v : JSON.stringify(v)}\n`
  if (Array.isArray(v)) return v.map((x) => `${pad}- ${typeof x === 'object' && x ? '\n' + toYaml(x, level + 1) : toYaml(x)}`).join('')
  return Object.entries(v)
    .map(([k, x]) => (x && typeof x === 'object' ? `${pad}${k}:\n${toYaml(x, level + 1)}` : `${pad}${k}: ${toYaml(x)}`))
    .join('')
}

// ---------------------------------------------------------------------------------------
// ansible-vault
// ---------------------------------------------------------------------------------------

register('ansible-vault', {
  usage: 'ansible-vault {create,decrypt,edit,view,encrypt,encrypt_string,rekey} [--vault-password-file ARCHIVO | -J] archivo',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-vault')
    const args = [...ctx.args]
    const verb = args.shift()
    const cfg = loadCfg(ctx)
    let passFile: string | undefined
    let ask = false
    let name: string | undefined
    let newPassFile: string | undefined
    const files: string[] = []
    let stdinName: string | undefined
    while (args.length) {
      const a = args.shift()!
      if (a === '--vault-password-file' || a === '--vault-pass-file') passFile = args.shift()
      else if (a.startsWith('--vault-password-file=')) passFile = a.split('=')[1]
      else if (a === '--vault-id') {
        const v = args.shift() ?? ''
        if (v.endsWith('prompt')) ask = true
        else passFile = v.replace(/^[^@]*@/, '')
      } else if (a === '-J' || a === '--ask-vault-pass') ask = true
      else if (a === '-n' || a === '--name') name = args.shift()
      else if (a === '--new-vault-password-file') newPassFile = args.shift()
      else if (a === '--stdin-name') stdinName = args.shift()
      else files.push(a)
    }
    const valid = ['create', 'decrypt', 'edit', 'view', 'encrypt', 'encrypt_string', 'rekey']
    if (!verb || !valid.includes(verb)) {
      ctx.err(`usage: ansible-vault [-h] [--version] [-v]\n                     {create,decrypt,edit,view,encrypt,encrypt_string,rekey}\n                     ...\nansible-vault: error: argument action: invalid choice: '${verb ?? ''}' (choose from 'create', 'decrypt', 'edit', 'view', 'encrypt', 'encrypt_string', 'rekey')\n`)
      return 2
    }
    const askPass = (confirm: boolean, label = 'Vault password'): string => {
      ctx.out(`${confirm ? 'New ' : ''}${label}: `)
      const p = ctx.stdin.readLine() ?? 'simulador'
      ctx.out('\n')
      if (confirm) {
        ctx.out(`Confirm ${confirm ? 'New ' : ''}${label}: `)
        ctx.stdin.readLine()
        ctx.out('\n')
      }
      return p
    }
    const needsNew = ['create', 'encrypt', 'encrypt_string'].includes(verb)
    let pass: string
    const pf = passFile ? abs(ctx, passFile) : cfg.vaultPasswordFile
    if (pf && !ask) {
      const t = readFileSafe(ctx, pf)
      if (t === undefined) {
        ctx.out(paint('error', `ERROR! The vault password file ${pf} was not found`) + '\n')
        return 1
      }
      pass = t.split('\n')[0].trim()
    } else pass = askPass(needsNew)
    const write = (p: string, text: string, mode = 0o600) => ctx.sys.vfs.writeFile(p, text, ctx.sh.cred, { mode })
    try {
      if (verb === 'encrypt_string') {
        const value = files[0] ?? (stdinName ? ctx.stdin.readAll().replace(/\n$/, '') : '')
        if (!files[0] && !stdinName) {
          ctx.out('Reading plaintext input from stdin. (ctrl-d to end input, twice if your content does not already have a newline)\n')
        }
        ctx.out(encryptString(value, pass, name ?? stdinName))
        ctx.err('Encryption successful\n')
        return 0
      }
      if (!files.length) {
        ctx.err(`ansible-vault ${verb}: error: the following arguments are required: args\n`)
        return 2
      }
      for (const f of files) {
        const p = abs(ctx, f)
        const text = readFileSafe(ctx, p)
        if (verb === 'create') {
          if (text !== undefined) {
            ctx.out(paint('error', `ERROR! ${f} exists, please use 'edit' instead`) + '\n')
            return 1
          }
          ctx.sh.pendingEditor = { path: p, content: '', editor: 'ansible-vault', password: pass }
          return 0
        }
        if (text === undefined) {
          ctx.out(paint('error', `ERROR! input is not vault encrypted data for ${p} is not a vault encrypted file for ${p}`.replace(/ for .* is not/, ' is not')) + '\n')
          return 1
        }
        if (verb === 'encrypt') {
          if (isVault(text)) {
            ctx.out(paint('error', `ERROR! input is already encrypted`) + '\n')
            return 1
          }
          write(p, encrypt(text, pass))
          ctx.out('Encryption successful\n')
        } else if (verb === 'decrypt') {
          write(p, decrypt(text, pass, p), 0o644)
          ctx.out('Decryption successful\n')
        } else if (verb === 'view') {
          ctx.out(decrypt(text, pass, p))
        } else if (verb === 'edit') {
          const plain = decrypt(text, pass, p)
          ctx.sh.pendingEditor = { path: p, content: plain, editor: 'ansible-vault', password: pass }
          return 0
        } else if (verb === 'rekey') {
          const plain = decrypt(text, pass, p)
          let np: string
          if (newPassFile) np = (readFileSafe(ctx, abs(ctx, newPassFile)) ?? '').split('\n')[0].trim()
          else np = askPass(true)
          write(p, encrypt(plain, np))
          ctx.out('Rekey successful\n')
        }
      }
      return 0
    } catch (e) {
      if (e instanceof VaultError) {
        ctx.out(paint('error', `ERROR! ${e.message}`) + '\n')
        return 1
      }
      throw e
    }
  },
})

// ---------------------------------------------------------------------------------------
// ansible-galaxy, ansible-doc, ansible-config, ansible-lint
// ---------------------------------------------------------------------------------------

const ROLE_SKELETON: Record<string, string> = {
  'README.md': 'Role Name\n=========\n\nA brief description of the role goes here.\n\nRequirements\n------------\n\nAny pre-requisites that may not be covered by Ansible itself or the role should be mentioned here.\n\nRole Variables\n--------------\n\nA description of the settable variables for this role should go here.\n\nDependencies\n------------\n\nA list of other roles hosted on Galaxy should go here.\n\nExample Playbook\n----------------\n\n    - hosts: servers\n      roles:\n         - { role: username.rolename, x: 42 }\n\nLicense\n-------\n\nBSD\n',
  'defaults/main.yml': '---\n# defaults file for {{ role }}\n',
  'handlers/main.yml': '---\n# handlers file for {{ role }}\n',
  'meta/main.yml': "galaxy_info:\n  author: your name\n  description: your role description\n  company: your company (optional)\n  license: license (GPL-2.0-or-later, MIT, etc)\n  min_ansible_version: 2.1\n  galaxy_tags: []\n\ndependencies: []\n  # List your role dependencies here, one per line. Be sure to remove the '[]' above,\n  # if you add dependencies to this list.\n",
  'tasks/main.yml': '---\n# tasks file for {{ role }}\n',
  'tests/inventory': 'localhost\n\n',
  'tests/test.yml': '---\n- hosts: localhost\n  remote_user: root\n  roles:\n    - {{ role }}\n',
  'vars/main.yml': '---\n# vars file for {{ role }}\n',
}

register('ansible-galaxy', {
  usage: 'ansible-galaxy role init NOMBRE | collection install NOMBRE [-p RUTA] | collection install -r requirements.yml | collection list',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-galaxy')
    const args = [...ctx.args]
    let kind = args.shift()
    if (kind === 'init' || kind === 'install' || kind === 'list') {
      args.unshift(kind)
      kind = 'role'
    }
    const verb = args.shift()
    const cfg = loadCfg(ctx)
    const write = (p: string, text: string) => {
      ctx.sys.vfs.mkdirp(p.replace(/\/[^/]+$/, ''), ctx.sh.cred)
      ctx.sys.vfs.writeFile(p, text, ctx.sh.cred)
    }
    try {
      if (kind === 'role' && verb === 'init') {
        let base = ctx.sh.cwd
        const names: string[] = []
        while (args.length) {
          const a = args.shift()!
          if (a === '--init-path' || a === '-p') base = abs(ctx, args.shift() ?? '.')
          else if (!a.startsWith('-')) names.push(a)
        }
        const name = names[0]
        if (!name) {
          ctx.err('ansible-galaxy role init: error: the following arguments are required: role_name\n')
          return 2
        }
        const dir = `${base}/${name}`
        if (ctx.sys.vfs.exists(dir)) {
          ctx.out(paint('error', `ERROR! - the directory ${dir} already exists. You can use --force to re-initialize this directory,\nhowever it will reset any main.yml files that may have\nbeen modified there already.`) + '\n')
          return 1
        }
        for (const [f, t] of Object.entries(ROLE_SKELETON)) write(`${dir}/${f}`, t.replace(/\{\{ role \}\}/g, name.split('.').pop()!))
        for (const d of ['files', 'templates']) ctx.sys.vfs.mkdirp(`${dir}/${d}`, ctx.sh.cred)
        ctx.out(`- Role ${name} was created successfully\n`)
        return 0
      }
      if (kind === 'collection' && verb === 'install') {
        let dest = cfg.collectionsPath[0]
        const names: string[] = []
        let req: string | undefined
        let force = false
        while (args.length) {
          const a = args.shift()!
          if (a === '-p' || a === '--collections-path') dest = abs(ctx, args.shift() ?? '.')
          else if (a === '-r' || a === '--requirements-file') req = args.shift()
          else if (a === '-f' || a === '--force') force = true
          else if (!a.startsWith('-')) names.push(a)
        }
        if (req) {
          const p = abs(ctx, req)
          const text = readFileSafe(ctx, p)
          if (text === undefined) {
            ctx.out(paint('error', `ERROR! The requirements file '${p}' does not exist.`) + '\n')
            return 1
          }
          const d = loadYaml(text).data as { collections?: unknown[] }
          for (const c of d?.collections ?? []) names.push(typeof c === 'string' ? c : `${(c as Record<string, unknown>).name}${(c as Record<string, unknown>).version ? `:${(c as Record<string, unknown>).version}` : ''}`)
        }
        if (!names.length) {
          ctx.err('ERROR! You must specify a collection name or a requirements file.\n')
          return 1
        }
        if (!ctx.sys.dns.length && !ctx.sys.resolveHost('galaxy.ansible.com')) {
          // sin salida a internet en el simulador se acepta igual
        }
        const todo: { name: string; version: string }[] = []
        const skipped: string[] = []
        for (const raw of names) {
          const i = raw.search(/[:=<>!]/)
          const name = i < 0 ? raw : raw.slice(0, i)
          const spec = i < 0 ? undefined : raw.slice(i).replace(/^:/, '')
          if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(name)) {
            ctx.out(paint('error', `ERROR! Invalid collection name '${name}', name must be in the format <namespace>.<collection>.`) + '\n')
            return 1
          }
          const version = resolveGalaxyVersion(name, spec)
          if (!version) {
            ctx.out('Starting galaxy collection install process\nProcess install dependency map\n')
            ctx.out(paint('error', `ERROR! Failed to resolve the requested dependencies map. Could not satisfy the following requirements:\n* ${name}:${spec} (direct request)`) + '\n')
            return 1
          }
          const [ns, coll] = name.split('.')
          const manifest = readFileSafe(ctx, `${dest}/ansible_collections/${ns}/${coll}/MANIFEST.json`)
          let have: string | undefined
          try {
            have = manifest ? (JSON.parse(manifest).collection_info?.version as string) : undefined
          } catch {
            have = undefined
          }
          if (have && !force && (!spec || versionMatches(have, spec))) skipped.push(`'${name}:${have}' is already installed, skipping.`)
          else todo.push({ name, version })
        }
        if (!todo.length) {
          ctx.out('Starting galaxy collection install process\nNothing to do. All requested collections are already installed. If you want to reinstall them, consider using `--force`.\n')
          return 0
        }
        ctx.out('Starting galaxy collection install process\nProcess install dependency map\nStarting collection install process\n')
        for (const m of skipped) ctx.out(m + '\n')
        for (const { name, version } of todo) {
          const [ns, coll] = name.split('.')
          const dir = `${dest}/ansible_collections/${ns}/${coll}`
          ctx.out(`Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/${ns}-${coll}-${version}.tar.gz to ${ctx.sh.home}/.ansible/tmp/ansible-local-${ctx.sys.allocPid()}/tmp/${ns}-${coll}-${version}.tar.gz\nInstalling '${name}:${version}' to '${dir}'\n`)
          write(`${dir}/MANIFEST.json`, JSON.stringify({ collection_info: { namespace: ns, name: coll, version } }, null, 2) + '\n')
          ctx.out(`${name}:${version} was installed successfully\n`)
        }
        return 0
      }
      if (kind === 'collection' && verb === 'list') {
        const run: Run = { ctx, cfg, o: parseOpts(ctx, []), inv: emptyInventory(), warnings: new Set(), out: ctx.out }
        const cols = installedCollections(run, ctx.sh.cwd)
        if (!cols.size) {
          ctx.out(paint('warn', '[WARNING]: No collections found') + '\n')
          return 0
        }
        const groups = new Map<string, [string, string][]>()
        for (const [n, v] of cols) {
          const where = ctx.sys.installed.has('ansible') && FULL_COLLECTIONS[n] === v ? '/usr/lib/python3/dist-packages/ansible_collections' : `${cfg.collectionsPath[0]}/ansible_collections`
          groups.set(where, [...(groups.get(where) ?? []), [n, v]])
        }
        for (const [where, list] of groups) {
          const w = Math.max(10, ...list.map(([n]) => n.length))
          ctx.out(`\n# ${where}\n${'Collection'.padEnd(w)} Version\n${'-'.repeat(w)} -------\n${list.sort().map(([n, v]) => `${n.padEnd(w)} ${v.padEnd(7)}\n`).join('')}`)
        }
        return 0
      }
      ctx.err('usage: ansible-galaxy [-h] [--version] [-v] TYPE ...\n\nPerform various Role and Collection related operations.\n\npositional arguments:\n  TYPE\n    collection   Manage an Ansible Galaxy collection.\n    role         Manage an Ansible Galaxy role.\n')
      return 2
    } catch (e) {
      return handleError(ctx, e)
    }
  },
})

const DOCS: Record<string, { short: string; options: string; example: string }> = {
  ping: { short: 'Try to connect to host, verify a usable python and return pong on success', options: '- data  Data to return for the ping return value. (default: pong)', example: '- name: Probar la conexión\n  ansible.builtin.ping:' },
  command: { short: 'Execute commands on targets', options: '- cmd      The command to run.\n- chdir    Change into this directory before running the command.\n- creates  A filename; when it already exists, this step will not be run.\n- removes  A filename; when it does not exist, this step will not be run.', example: '- name: Ver la versión del kernel\n  ansible.builtin.command: uname -r\n  register: kernel\n  changed_when: false' },
  shell: { short: 'Execute shell commands on targets', options: '- cmd      The shell command to run (pipes and redirections work).\n- chdir    Change into this directory before running the command.\n- creates  A filename; when it already exists, this step will not be run.', example: '- name: Contar los procesos de nginx\n  ansible.builtin.shell: ps aux | grep -c [n]ginx\n  changed_when: false' },
  package: { short: 'Generic OS package manager', options: '- name   (required) Package name, or package specifier with version.\n- state  Whether to install (present), or remove (absent) a package. (present, absent, latest)', example: '- name: Instalar nginx\n  ansible.builtin.package:\n    name: nginx\n    state: present' },
  dnf: { short: 'Manages packages with the dnf package manager', options: '- name   A package name or list of names.\n- state  present, absent, latest (default: present)\n- update_cache  Force dnf to check if cache is out of date.', example: '- name: Instalar paquetes\n  ansible.builtin.dnf:\n    name: [nginx, firewalld]\n    state: present' },
  apt: { short: 'Manages apt-packages', options: '- name          A list of package names.\n- state         present, absent, latest, build-dep, fixed\n- update_cache  Run the equivalent of apt-get update before the operation.\n- upgrade       If yes or safe, performs an aptitude safe-upgrade.', example: '- name: Instalar nginx\n  ansible.builtin.apt:\n    name: nginx\n    update_cache: true' },
  service: { short: 'Manage services', options: '- name     (required) Name of the service.\n- state    started, stopped, restarted, reloaded\n- enabled  Whether the service should start on boot.', example: '- name: nginx activo y habilitado\n  ansible.builtin.service:\n    name: nginx\n    state: started\n    enabled: true' },
  copy: { short: 'Copy files to remote locations', options: '- dest     (required) Remote absolute path where the file should be copied to.\n- src      Local path to a file to copy to the remote server.\n- content  When used instead of src, sets the contents of a file directly.\n- owner, group, mode  Ownership and permissions of the file.\n- backup   Create a backup file including the timestamp information.\n- validate The validation command to run before copying the updated file into the final destination (%s is the temporary file).', example: "- name: Archivo de sudo para el grupo de operaciones\n  ansible.builtin.copy:\n    content: \"%operaciones ALL=(ALL) ALL\\n\"\n    dest: /etc/sudoers.d/operaciones\n    mode: '0440'\n    validate: /usr/sbin/visudo -cf %s" },
  template: { short: 'Template a file out to a target host', options: '- src   (required) Path of a Jinja2 formatted template on the Ansible controller.\n- dest  (required) Location to render the template to on the remote machine.\n- owner, group, mode, backup, validate  Same as copy.', example: "- name: Sitio de nginx\n  ansible.builtin.template:\n    src: tienda.conf.j2\n    dest: /etc/nginx/conf.d/tienda.conf\n    mode: '0644'\n  notify: Recargar nginx" },
  file: { short: 'Manage files and file properties', options: '- path   (required) Path to the file being managed.\n- state  absent, directory, file, hard, link, touch\n- owner, group, mode  Ownership and permissions.\n- recurse  Recursively set the specified file attributes on directory contents.', example: "- name: Carpeta del sitio\n  ansible.builtin.file:\n    path: /srv/tienda\n    state: directory\n    owner: nginx\n    mode: '0755'" },
  lineinfile: { short: 'Manage lines in text files', options: '- path    (required) The file to modify.\n- regexp  The regular expression to look for in every line of the file.\n- line    The line to insert/replace into the file.\n- state   present, absent\n- validate  The validation command to run before writing the file.', example: "- name: Sin acceso de root por SSH\n  ansible.builtin.lineinfile:\n    path: /etc/ssh/sshd_config\n    regexp: '^#?PermitRootLogin'\n    line: PermitRootLogin no\n    validate: /usr/sbin/sshd -t -f %s\n  notify: Reiniciar sshd" },
  user: { short: 'Manage user accounts', options: '- name    (required) Name of the user to create, remove or modify.\n- groups  A list of supplementary groups.\n- append  If true, add the user to the groups specified in groups.\n- shell, home, uid, comment, password (hash), state, remove', example: "- name: Usuario ana\n  ansible.builtin.user:\n    name: ana\n    groups: wheel\n    append: true" },
  firewalld: { short: 'Manage arbitrary ports/services with firewalld (ansible.posix)', options: '- service    Name of a service to add/remove to/from firewalld.\n- port       Name of a port or port range to add/remove (80/tcp).\n- permanent  Should this configuration be in the running firewalld configuration or persist across reboots.\n- immediate  Should this configuration be applied immediately, if set as permanent.\n- state      (required) enabled, disabled, present, absent', example: '- name: Abrir http\n  ansible.posix.firewalld:\n    service: http\n    permanent: true\n    immediate: true\n    state: enabled' },
  debug: { short: 'Print statements during execution', options: '- msg        The customized message that is printed.\n- var        A variable name to debug.\n- verbosity  A number that controls when the debug is run.', example: "- name: Mostrar la distribución\n  ansible.builtin.debug:\n    msg: \"{{ ansible_facts['distribution'] }} {{ ansible_facts['distribution_version'] }}\"" },
}

register('ansible-doc', {
  usage: 'ansible-doc [-l] [-s] MÓDULO',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-doc')
    const args = ctx.args.filter((a) => !a.startsWith('-'))
    if (ctx.args.includes('-l') || ctx.args.includes('--list')) {
      const names = Object.keys(DOCS).sort()
      ctx.out(names.map((n) => `${(MODULE_COLLECTION[n] ?? 'ansible.builtin') + '.' + n}`.padEnd(32) + ` ${DOCS[n].short}\n`).join(''))
      return 0
    }
    const name = args[0]
    if (!name) {
      ctx.err('usage: ansible-doc [-h] [--version] [-v] [-M MODULE_PATH] [-l] [-s] [plugin ...]\n')
      return 2
    }
    const short = name.split('.').pop()!
    const d = DOCS[short]
    if (!d) {
      ctx.out(paint('warn', `[WARNING]: ${short} was not found`) + '\n')
      return 1
    }
    const fq = `${MODULE_COLLECTION[short] ?? 'ansible.builtin'}.${short}`
    if (ctx.args.includes('-s') || ctx.args.includes('--snippet')) {
      ctx.out(`${d.example}\n`)
      return 0
    }
    ctx.out(`> ${fq.toUpperCase()}    (/usr/lib/python3/site-packages/ansible/modules/${short}.py)\n\n  ${d.short}\n\nOPTIONS (= is mandatory):\n\n${d.options.split('\n').map((l) => `  ${l}`).join('\n')}\n\nEXAMPLES:\n\n${d.example.split('\n').map((l) => `  ${l}`).join('\n')}\n`)
    return 0
  },
})

register('ansible-config', {
  usage: 'ansible-config {list,dump,view,init} [--only-changed]',
  path: '/usr/bin',
  async run(ctx) {
    if (!installedCore(ctx.sys)) return notInstalled(ctx, 'ansible-config')
    const cfg = loadCfg(ctx)
    const verb = ctx.args[0]
    if (verb === 'view') {
      if (!cfg.file) {
        ctx.out(paint('error', 'ERROR! No config file found to view') + '\n')
        return 1
      }
      ctx.out(readFileSafe(ctx, cfg.file) ?? '')
      return 0
    }
    if (verb === 'dump') {
      const rows: [string, string, string][] = [
        ['CONFIG_FILE', '() = ', cfg.file ?? 'None'],
        ['DEFAULT_BECOME', cfg.become ? `(${cfg.file}) = ` : '(default) = ', String(cfg.become ? 'True' : 'False')],
        ['DEFAULT_HOST_LIST', cfg.inventory[0] !== '/etc/ansible/hosts' ? `(${cfg.file}) = ` : '(default) = ', `[${cfg.inventory.map((i) => `'${i}'`).join(', ')}]`],
        ['DEFAULT_REMOTE_USER', cfg.remoteUser ? `(${cfg.file}) = ` : '(default) = ', cfg.remoteUser ?? 'None'],
        ['DEFAULT_ROLES_PATH', `(${cfg.file ?? 'default'}) = `, `[${cfg.rolesPath.map((i) => `'${i}'`).join(', ')}]`],
        ['DEFAULT_VAULT_PASSWORD_FILE', cfg.vaultPasswordFile ? `(${cfg.file}) = ` : '(default) = ', cfg.vaultPasswordFile ?? 'None'],
        ['HOST_KEY_CHECKING', cfg.hostKeyChecking ? '(default) = ' : `(${cfg.file}) = `, cfg.hostKeyChecking ? 'True' : 'False'],
        ['INTERPRETER_PYTHON', cfg.interpreterPython ? `(${cfg.file}) = ` : '(default) = ', cfg.interpreterPython ?? 'auto'],
      ]
      const only = ctx.args.includes('--only-changed')
      for (const [k, src, v] of rows) if (!only || !src.startsWith('(default)')) ctx.out(`${k}${src}${v}\n`)
      return 0
    }
    if (verb === 'init') {
      ctx.out('[defaults]\n# (pathlist) Comma separated list of Ansible inventory sources\n;inventory=/etc/ansible/hosts\n\n# (string) Sets the login user for the target machines\n;remote_user=\n\n# (boolean) Set this to "False" if you want to avoid host key checking by the underlying connection plugin\n;host_key_checking=True\n\n[privilege_escalation]\n;become=False\n;become_user=root\n')
      return 0
    }
    ctx.err('usage: ansible-config [-h] [--version] [-v] {list,dump,view,init} ...\n')
    return 2
  },
})

register('ansible-lint', {
  usage: 'ansible-lint [archivo ...]',
  path: '/usr/bin',
  async run(ctx) {
    if (!ctx.sys.installed.has('ansible-lint')) return notInstalled(ctx, 'ansible-lint')
    if (ctx.args.includes('--version')) {
      ctx.out(`ansible-lint 6.17.2 using ansible-core:${CORE_VERSION[ctx.sys.distro]} ansible-compat:4.1.11 ruamel-yaml:0.17.21 ruamel-yaml-clib:0.2.8\n`)
      return 0
    }
    const targets = ctx.args.filter((a) => !a.startsWith('-'))
    const files: { path: string; shown: string; text: string }[] = []
    const add = (p: string, shownName: string) => {
      const t = readFileSafe(ctx, p)
      if (t !== undefined && !isVault(t)) files.push({ path: p, shown: shownName, text: t })
    }
    const walk = (dir: string, rel: string) => {
      let entries: string[]
      try {
        entries = ctx.sys.vfs.readdir(dir, ctx.sh.cred).sort()
      } catch {
        return
      }
      for (const e of entries) {
        if (e.startsWith('.') || e === 'collections') continue
        const p = `${dir}/${e}`
        let st
        try {
          st = ctx.sys.vfs.stat(p, ctx.sh.cred)
        } catch {
          continue
        }
        if (st.type === 'dir') walk(p, rel ? `${rel}/${e}` : e)
        else if (/\.ya?ml$/.test(e)) add(p, rel ? `${rel}/${e}` : e)
      }
    }
    if (!targets.length) walk(ctx.sh.cwd, '')
    else
      for (const t of targets) {
        const p = abs(ctx, t)
        try {
          if (ctx.sys.vfs.stat(p, ctx.sh.cred).type === 'dir') walk(p, t.replace(/\/$/, ''))
          else add(p, t)
        } catch {
          ctx.err(`WARNING  Unable to load ${t}: file not found\n`)
        }
      }
    const report = lintFiles(files.map((f) => ({ name: f.shown, text: f.text })))
    ctx.out(report.output)
    return report.failures ? 2 : 0
  },
})
