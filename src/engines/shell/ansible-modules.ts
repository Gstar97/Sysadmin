/**
 * Módulos de Ansible para los equipos simulados. Cada uno compara el estado actual con el
 * pedido y cambia solo lo necesario (idempotencia), respeta el modo de prueba (--check),
 * arma las diferencias de --diff y devuelve un resultado con las mismas claves que el real.
 * Por dentro usan los mismos comandos del simulador (dnf, systemctl, useradd, firewall-cmd),
 * así lo que hace Ansible queda igual que si lo hubieras hecho a mano.
 */
import type { System } from './system'
import { FsError, ROOT_CRED, normalizePath, type Cred } from './vfs'

export type Result = Record<string, unknown> & {
  changed?: boolean
  failed?: boolean
  msg?: string
  skipped?: boolean
  diff?: FileDiff | FileDiff[]
}

export interface FileDiff {
  before: string
  after: string
  before_header?: string
  after_header?: string
}

export interface Target {
  sys: System
  /** Usuario con el que corre el módulo (el de become, si hay). */
  user: string
  cred: Cred
  exec(cmd: string, stdin?: string): Promise<{ rc: number; stdout: string; stderr: string }>
}

export interface ModuleCtx {
  args: Record<string, unknown>
  t: Target
  check: boolean
  /** Busca un archivo del nodo de control (files/ o templates/ del rol o del playbook). */
  findSrc(kind: 'files' | 'templates', src: string): string | undefined
  readControl(path: string): string
  render(text: string): string
  /** Variables del equipo, ya resueltas, para módulos como debug y set_fact. */
  vars: Record<string, unknown>
  inventoryHostname: string
  /** Facts del equipo (para package, service y setup). */
  facts: () => Record<string, unknown>
}

export type ModuleFn = (m: ModuleCtx) => Promise<Result>

export class ModuleArgError extends Error {}

// ---------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------

export const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`)

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))
const bool = (v: unknown, def = false): boolean => {
  if (v === undefined || v === null) return def
  if (typeof v === 'boolean') return v
  return ['yes', 'true', 'on', '1', 'y'].includes(String(v).toLowerCase())
}
const list = (v: unknown): string[] => {
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v.map(String)
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function need(m: ModuleCtx, ...names: string[]) {
  const missing = names.filter((n) => m.args[n] === undefined || m.args[n] === null)
  if (missing.length) throw new ModuleArgError(`missing required arguments: ${missing.join(', ')}`)
}

function choices(m: ModuleCtx, name: string, allowed: string[], def?: string): string | undefined {
  const v = str(m.args[name]) ?? def
  if (v !== undefined && !allowed.includes(v)) throw new ModuleArgError(`value of ${name} must be one of: ${allowed.join(', ')}, got: ${v}`)
  return v
}

export function modeStr(mode: number): string {
  return '0' + (mode & 0o7777).toString(8).padStart(3, '0')
}

/** mode: "0644", 0644 (YAML lo lee en octal), "u=rw,g=r,o=r" o "preserve". */
export function parseMode(v: unknown, current?: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number') return v & 0o7777
  const s = String(v).trim()
  if (/^0?[0-7]{3,4}$/.test(s)) return parseInt(s, 8)
  if (/^[ugoa]*[=+-][rwxXst]*(,[ugoa]*[=+-][rwxXst]*)*$/.test(s)) {
    let mode = current ?? 0
    for (const part of s.split(',')) {
      const m = /^([ugoa]*)([=+-])([rwxXst]*)$/.exec(part)!
      const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1]
      let bits = 0
      for (const w of who) {
        const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0
        if (m[3].includes('r')) bits |= 4 << shift
        if (m[3].includes('w')) bits |= 2 << shift
        if (m[3].includes('x') || m[3].includes('X')) bits |= 1 << shift
      }
      const mask = [...who].reduce((a, w) => a | (7 << (w === 'u' ? 6 : w === 'g' ? 3 : 0)), 0)
      if (m[2] === '=') mode = (mode & ~mask) | bits
      else if (m[2] === '+') mode |= bits
      else mode &= ~bits
    }
    return mode
  }
  throw new ModuleArgError(`mode must be in octal or symbolic form`)
}

function fsMessage(e: unknown, path: string): string {
  if (e instanceof FsError) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return `[Errno 13] Permission denied: b'${path}'`
    if (e.code === 'ENOENT') return `[Errno 2] No such file or directory: b'${path}'`
    if (e.code === 'ENOTDIR') return `[Errno 20] Not a directory: b'${path}'`
    if (e.code === 'EISDIR') return `[Errno 21] Is a directory: b'${path}'`
  }
  return String((e as Error).message ?? e)
}

interface FileInfo {
  exists: boolean
  type?: 'file' | 'dir' | 'symlink'
  data?: string
  mode?: number
  uid?: number
  gid?: number
}

function info(t: Target, path: string, follow = true): FileInfo {
  try {
    const st = t.sys.vfs.stat(path, ROOT_CRED, follow)
    return { exists: true, type: st.type, data: st.type === 'file' ? st.data : undefined, mode: st.mode, uid: st.uid, gid: st.gid }
  } catch {
    return { exists: false }
  }
}

function uidOf(sys: System, user: string): number | undefined {
  if (/^\d+$/.test(user)) return Number(user)
  return sys.users.get(user)?.uid
}
function gidOf(sys: System, group: string): number | undefined {
  if (/^\d+$/.test(group)) return Number(group)
  return sys.groups.get(group)?.gid
}
function userName(sys: System, uid: number) {
  return [...sys.users.values()].find((u) => u.uid === uid)?.name ?? String(uid)
}

/** Dueño, grupo y permisos de un archivo; devuelve si cambió algo (en modo prueba, si cambiaría). */
function applyAttrs(m: ModuleCtx, path: string, check: boolean): { changed: boolean; error?: string; before: Record<string, string>; after: Record<string, string> } {
  const t = m.t
  const st = info(t, path)
  const before: Record<string, string> = {}
  const after: Record<string, string> = {}
  if (!st.exists) return { changed: false, before, after }
  let changed = false
  const owner = str(m.args.owner)
  const group = str(m.args.group)
  const mode = parseMode(m.args.mode, st.mode)
  let uid: number | undefined
  let gid: number | undefined
  if (owner !== undefined) {
    uid = uidOf(t.sys, owner)
    if (uid === undefined) return { changed: false, error: `chown failed: failed to look up user ${owner}`, before, after }
  }
  if (group !== undefined) {
    gid = gidOf(t.sys, group)
    if (gid === undefined) return { changed: false, error: `chgrp failed: failed to look up group ${group}`, before, after }
  }
  if (uid !== undefined && uid !== st.uid) {
    if (t.cred.uid !== 0) return { changed: false, error: `chown failed: [Errno 1] Operation not permitted: b'${path}'`, before, after }
    before.owner = userName(t.sys, st.uid!)
    after.owner = owner!
    changed = true
    if (!check) t.sys.vfs.chown(path, uid, undefined, ROOT_CRED)
  }
  if (gid !== undefined && gid !== st.gid) {
    before.group = t.sys.groupName(st.gid!)
    after.group = group!
    changed = true
    if (!check) t.sys.vfs.chown(path, undefined, gid, ROOT_CRED)
  }
  if (mode !== undefined && mode !== ((st.mode ?? 0) & 0o7777)) {
    if (t.cred.uid !== 0 && t.cred.uid !== st.uid) return { changed: false, error: `chmod failed: [Errno 1] Operation not permitted: b'${path}'`, before, after }
    before.mode = modeStr(st.mode ?? 0)
    after.mode = modeStr(mode)
    changed = true
    if (!check) t.sys.vfs.chmod(path, mode, ROOT_CRED)
  }
  return { changed, before, after }
}

/** Resultado de los módulos de archivos (path, owner, group, mode, state, size). */
function fileResult(t: Target, path: string, extra: Result = {}): Result {
  const st = info(t, path)
  if (!st.exists) return { path, state: 'absent', ...extra }
  return {
    path,
    owner: userName(t.sys, st.uid!),
    uid: st.uid,
    group: t.sys.groupName(st.gid!),
    gid: st.gid,
    mode: modeStr(st.mode ?? 0),
    state: st.type === 'dir' ? 'directory' : st.type === 'symlink' ? 'link' : 'file',
    size: st.type === 'dir' ? 4096 : (st.data ?? '').length,
    ...extra,
  }
}

/** Diferencias unificadas, como las que muestra --diff. */
export function unifiedDiff(a: string, b: string, ctxLines = 3): string {
  const A = a === '' ? [] : a.replace(/\n$/, '').split('\n')
  const B = b === '' ? [] : b.replace(/\n$/, '').split('\n')
  const n = A.length
  const mm = B.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(mm + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = mm - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = []
  let i = 0
  let j = 0
  while (i < n || j < mm) {
    if (i < n && j < mm && A[i] === B[j]) ops.push({ t: ' ', s: A[i++], ai: i, bi: ++j })
    else if (i < n && (j >= mm || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: '-', s: A[i++], ai: i, bi: j })
    else ops.push({ t: '+', s: B[j++], ai: i, bi: j })
  }
  const out: string[] = []
  let k = 0
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === ' ') k++
    if (k >= ops.length) break
    const start = Math.max(0, k - ctxLines)
    let end = k
    while (end < ops.length) {
      if (ops[end].t !== ' ') {
        end++
        continue
      }
      let run = 0
      while (end + run < ops.length && ops[end + run].t === ' ') run++
      if (end + run >= ops.length || run > ctxLines * 2) {
        end = Math.min(ops.length, end + ctxLines)
        break
      }
      end += run
    }
    const hunk = ops.slice(start, end)
    const aStart = hunk.filter((o) => o.t !== '+').length ? hunk.find((o) => o.t !== '+')!.ai : hunk[0].ai
    const bStart = hunk.filter((o) => o.t !== '-').length ? hunk.find((o) => o.t !== '-')!.bi : hunk[0].bi
    const aLen = hunk.filter((o) => o.t !== '+').length
    const bLen = hunk.filter((o) => o.t !== '-').length
    out.push(`@@ -${aLen ? aStart : aStart}${aLen === 1 ? '' : `,${aLen}`} +${bLen ? bStart : bStart}${bLen === 1 ? '' : `,${bLen}`} @@`)
    for (const o of hunk) out.push(`${o.t}${o.s}`)
    k = end
  }
  return out.join('\n') + (out.length ? '\n' : '')
}

/** Escribe un archivo con el contenido pedido; lo usan copy, template, lineinfile, etc. */
async function writeContent(m: ModuleCtx, dest: string, content: string, srcHeader: string | undefined, opts: { backup?: boolean; validate?: string; create?: boolean } = {}): Promise<Result> {
  const t = m.t
  const st = info(t, dest)
  if (st.exists && st.type === 'dir') return { failed: true, msg: `Destination ${dest} is a directory`, changed: false }
  const parent = dest.replace(/\/[^/]+$/, '') || '/'
  if (!info(t, parent).exists) return { failed: true, msg: `Destination directory ${parent} does not exist`, changed: false, checksum: undefined }
  const before = st.exists ? (st.data ?? '') : ''
  const contentChanged = !st.exists || before !== content
  const diff: FileDiff = { before, after: content, before_header: st.exists ? dest : dest, after_header: srcHeader ?? dest }
  const res: Result = { changed: false, dest }
  if (contentChanged) {
    res.changed = true
    if (!m.check) {
      if (opts.validate) {
        const tmp = `/tmp/.ansible_tmp_${Math.abs(dest.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}`
        try {
          t.sys.vfs.writeFile(tmp, content, ROOT_CRED, { mode: 0o600 })
        } catch (e) {
          return { failed: true, changed: false, msg: fsMessage(e, tmp) }
        }
        const r = await t.exec(opts.validate.includes('%s') ? opts.validate.replace('%s', tmp) : `${opts.validate} ${tmp}`)
        try {
          t.sys.vfs.unlink(tmp, ROOT_CRED)
        } catch {
          // ya no está
        }
        if (r.rc !== 0) return { failed: true, changed: false, exit_status: r.rc, stdout: r.stdout, stderr: r.stderr, msg: `failed to validate` }
      }
      if (opts.backup && st.exists) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const bak = `${dest}.${t.sys.allocPid()}.${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}@${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}~`
        try {
          t.sys.vfs.copy(dest, bak, ROOT_CRED, { preserve: true })
          res.backup_file = bak
        } catch {
          // sin copia
        }
      }
      try {
        t.sys.vfs.writeFile(dest, content, t.cred)
      } catch (e) {
        if (e instanceof FsError && (e.code === 'EACCES' || e.code === 'EPERM')) return { failed: true, changed: false, msg: `Destination ${parent} not writable` }
        return { failed: true, changed: false, msg: fsMessage(e, dest) }
      }
    }
  }
  const attrs = applyAttrs(m, dest, m.check)
  if (attrs.error) return { failed: true, changed: false, msg: attrs.error }
  if (attrs.changed) res.changed = true
  const diffs: FileDiff[] = []
  if (contentChanged) diffs.push(diff)
  if (attrs.changed) diffs.push({ before: Object.entries(attrs.before).map(([k, v]) => `${k}: ${v}\n`).join(''), after: Object.entries(attrs.after).map(([k, v]) => `${k}: ${v}\n`).join(''), before_header: `${dest} (attributes)`, after_header: `${dest} (attributes)` })
  return { ...fileResult(t, dest), ...res, diff: diffs, checksum: contentChanged ? undefined : undefined }
}

function controlFile(m: ModuleCtx, kind: 'files' | 'templates', src: string): { path?: string; text?: string; error?: string } {
  const path = m.findSrc(kind, src)
  if (!path) {
    return { error: `Could not find or access '${src}'\nSearched in:\n\t${kind === 'templates' ? 'templates' : 'files'}/${src}\n\t${src}\n on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option` }
  }
  try {
    return { path, text: m.readControl(path) }
  } catch {
    return { error: `Could not find or access '${src}' on the Ansible Controller.` }
  }
}

function destFor(m: ModuleCtx, dest: string, src?: string): string {
  if (src && (dest.endsWith('/') || info(m.t, dest).type === 'dir')) return normalizePath(`${dest}/${src.split('/').pop()}`)
  return normalizePath(dest)
}

// ---------------------------------------------------------------------------------------
// Paquetes y servicios
// ---------------------------------------------------------------------------------------

function pkgInstalled(sys: System, name: string) {
  return sys.installed.has(name.replace(/[<>=].*$/, '').replace(/-\d.*$/, (x) => (sys.installed.has(name) ? '' : x)))
}

async function packageModule(m: ModuleCtx, mgr: 'dnf' | 'apt' | 'auto'): Promise<Result> {
  const sys = m.t.sys
  const real = mgr === 'auto' ? (sys.distro === 'ubuntu' ? 'apt' : 'dnf') : mgr
  if (real === 'apt' && sys.distro !== 'ubuntu') return { failed: true, changed: false, msg: 'Could not import the python3-apt module. Is apt installed on this system?' }
  if (real === 'dnf' && sys.distro === 'ubuntu') return { failed: true, changed: false, msg: 'Could not import the dnf python module using /usr/bin/python3 (3.12.3 (main, Jun 18 2025, 17:59:45) [GCC 13.3.0]). Please install `python3-dnf` package or ensure you have specified the correct ansible_python_interpreter. (attempted [\'/usr/libexec/platform-python\', \'/usr/bin/python3\', \'/usr/bin/python2\', \'/usr/bin/python\'])', results: [] }
  const names = list(m.args.name ?? m.args.pkg)
  const state = str(m.args.state) ?? 'present'
  const upgradeAll = real === 'apt' ? m.args.upgrade !== undefined && String(m.args.upgrade) !== 'no' : names.length === 1 && names[0] === '*' && state === 'latest'
  if (!['present', 'installed', 'latest', 'absent', 'removed'].includes(state)) throw new ModuleArgError(`value of state must be one of: absent, installed, latest, present, removed, got: ${state}`)
  if (m.t.cred.uid !== 0) {
    if (real === 'apt') return { failed: true, changed: false, msg: "'/usr/bin/apt-get -y -o \"Dpkg::Options::=--force-confdef\" -o \"Dpkg::Options::=--force-confold\"       install 'nginx'' failed: E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n", rc: 100 }
    return { failed: true, changed: false, msg: 'This command has to be run under the root user.', results: [] }
  }
  if (real === 'apt' && bool(m.args.update_cache) && !m.check) await m.t.exec('apt-get update -qq')
  if (upgradeAll) {
    if (m.check) return { changed: true, msg: 'Check mode: No changes made, but would have if not in check mode' }
    const r = await m.t.exec(real === 'apt' ? 'apt-get -y upgrade' : 'dnf -y upgrade')
    return { changed: !/Nothing to do|0 upgraded/.test(r.stdout), msg: '', rc: r.rc, results: [] }
  }
  if (!names.length) {
    if (real === 'apt' && bool(m.args.update_cache)) return { changed: false, cache_updated: true, cache_update_time: Math.floor(Date.now() / 1000) }
    throw new ModuleArgError('one of the following is required: name, pkg, upgrade, update_cache, deb, autoremove')
  }
  const want = state === 'absent' || state === 'removed' ? 'absent' : 'present'
  const todo = names.filter((n) => (want === 'present' ? !pkgInstalled(sys, n) : pkgInstalled(sys, n)))
  if (!todo.length) return real === 'apt' ? { changed: false, cache_updated: false } : { changed: false, msg: 'Nothing to do', rc: 0, results: [] }
  // ¿Existen?
  if (want === 'present') {
    const missing = todo.filter((n) => !sys.catalog[n])
    if (missing.length) {
      if (real === 'apt') return { failed: true, changed: false, msg: `No package matching '${missing[0]}' is available` }
      return { failed: true, changed: false, failures: missing.map((n) => `No package ${n} available.`), msg: 'Failed to install some of the specified packages', rc: 1, results: [] }
    }
  }
  if (m.check) return { changed: true, msg: `Check mode: No changes made, but would have if not in check mode`, results: todo.map((n) => `${want === 'present' ? 'Installed' : 'Removed'}: ${n}`) }
  const cmd = real === 'apt' ? `apt-get -y ${want === 'present' ? 'install' : 'remove'} ${todo.map(q).join(' ')}` : `dnf -y ${want === 'present' ? 'install' : 'remove'} ${todo.map(q).join(' ')}`
  const r = await m.t.exec(cmd)
  if (r.rc !== 0) {
    const missing = todo.filter((n) => new RegExp(`(No match for argument|Unable to locate package):? ${n.replace(/[.+]/g, '\\$&')}`).test(r.stdout + r.stderr))
    if (real === 'dnf' && missing.length) return { failed: true, changed: false, failures: missing.map((n) => `No package ${n} available.`), msg: 'Failed to install some of the specified packages', rc: 1, results: [] }
    if (real === 'apt' && missing.length) return { failed: true, changed: false, msg: `No package matching '${missing[0]}' is available` }
    return { failed: true, changed: false, msg: r.stderr.trim() || r.stdout.trim(), rc: r.rc, results: [] }
  }
  if (real === 'apt') return { changed: true, cache_updated: false, stdout: r.stdout, stderr: r.stderr }
  return { changed: true, msg: '', rc: 0, results: todo.map((n) => `${want === 'present' ? 'Installed' : 'Removed'}: ${n}-${sys.catalog[n]?.version ?? ''}`) }
}

async function serviceModule(m: ModuleCtx): Promise<Result> {
  const name = str(m.args.name)
  const state = choices(m, 'state', ['started', 'stopped', 'restarted', 'reloaded'])
  const enabled = m.args.enabled === undefined ? undefined : bool(m.args.enabled)
  const daemonReload = bool(m.args.daemon_reload)
  const res: Result = { changed: false }
  if (daemonReload && !m.check) await m.t.exec('systemctl daemon-reload')
  if (!name) {
    if (daemonReload) return { changed: false, name: null, status: {} }
    throw new ModuleArgError('missing required arguments: name')
  }
  res.name = name
  const unit = name.includes('.') ? name : `${name}.service`
  const exists = await m.t.exec(`systemctl list-unit-files ${q(unit)}`)
  if (!new RegExp(`^${unit.replace(/\./g, '\\.')}\\s`, 'm').test(exists.stdout)) {
    return { failed: true, changed: false, msg: `Could not find the requested service ${name}: host` }
  }
  if (m.t.cred.uid !== 0 && (state || enabled !== undefined)) {
    const verb = state === 'stopped' ? 'stop' : state === 'restarted' ? 'restart' : state === 'reloaded' ? 'reload' : 'start'
    return { failed: true, changed: false, msg: `Unable to ${verb} service ${name}: Failed to ${verb} ${unit}: Interactive authentication required.\nSee system logs and 'systemctl status ${unit}' for details.\n` }
  }
  const isEnabled = async () => (await m.t.exec(`systemctl is-enabled ${q(unit)}`)).stdout.trim() === 'enabled'
  const isActive = async () => (await m.t.exec(`systemctl is-active ${q(unit)}`)).stdout.trim() === 'active'
  if (enabled !== undefined) {
    const now = await isEnabled()
    if (now !== enabled) {
      res.changed = true
      if (!m.check) {
        const r = await m.t.exec(`systemctl ${enabled ? 'enable' : 'disable'} ${q(unit)}`)
        if (r.rc !== 0) return { failed: true, changed: false, msg: `Unable to ${enabled ? 'enable' : 'disable'} service ${name}: ${r.stderr}` }
      }
    }
    res.enabled = enabled
  }
  if (state) {
    const active = await isActive()
    let verb: string | undefined
    if (state === 'started' && !active) verb = 'start'
    else if (state === 'stopped' && active) verb = 'stop'
    else if (state === 'restarted') verb = 'restart'
    else if (state === 'reloaded') verb = active ? 'reload' : 'start'
    if (verb) {
      res.changed = true
      if (!m.check) {
        const r = await m.t.exec(`systemctl ${verb} ${q(unit)}`)
        if (r.rc !== 0) return { failed: true, changed: false, name, msg: `Unable to ${verb} service ${name}: ${r.stderr}` }
      }
    }
    res.state = state
  }
  res.status = { ActiveState: (await isActive()) ? 'active' : 'inactive' }
  return res
}

// ---------------------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------------------

const copyModule: ModuleFn = async (m) => {
  need(m, 'dest')
  const src = str(m.args.src)
  let content = str(m.args.content)
  let header: string | undefined
  if (src === undefined && content === undefined) throw new ModuleArgError('src (or content) is required')
  if (src !== undefined && content !== undefined) throw new ModuleArgError('parameters are mutually exclusive: content|src')
  if (bool(m.args.remote_src)) {
    try {
      content = m.t.sys.vfs.readFile(src!, ROOT_CRED)
    } catch {
      return { failed: true, changed: false, msg: `Source ${src} not found` }
    }
  } else if (src !== undefined) {
    const f = controlFile(m, 'files', src)
    if (f.error) return { failed: true, changed: false, msg: f.error }
    content = f.text!
    header = f.path
  }
  const dest = destFor(m, String(m.args.dest), src)
  if (!bool(m.args.force, true) && info(m.t, dest).exists) return { changed: false, dest, msg: 'file already exists' }
  return writeContent(m, dest, content!, header, { backup: bool(m.args.backup), validate: str(m.args.validate) })
}

const templateModule: ModuleFn = async (m) => {
  need(m, 'src', 'dest')
  const src = String(m.args.src)
  const f = controlFile(m, 'templates', src)
  if (f.error) return { failed: true, changed: false, msg: f.error }
  let text: string
  try {
    text = m.render(f.text!)
  } catch (e) {
    const msg = (e as Error).message
    return { failed: true, changed: false, msg: /is undefined/.test(msg) ? `AnsibleUndefinedVariable: ${msg.replace(/^line \d+: /, '')}` : `AnsibleError: template error while templating string: ${msg}` }
  }
  const dest = destFor(m, String(m.args.dest), src.replace(/\.j2$/, ''))
  return writeContent(m, dest, text, f.path, { backup: bool(m.args.backup), validate: str(m.args.validate) })
}

const fileModule: ModuleFn = async (m) => {
  const path = str(m.args.path ?? m.args.dest ?? m.args.name)
  if (!path) throw new ModuleArgError('missing required arguments: path')
  const t = m.t
  const st = info(t, path, false)
  const state = choices(m, 'state', ['absent', 'directory', 'file', 'hard', 'link', 'touch']) ?? (st.exists ? (st.type === 'dir' ? 'directory' : st.type === 'symlink' ? 'link' : 'file') : 'file')
  const before = st.exists ? (st.type === 'dir' ? 'directory' : st.type === 'symlink' ? 'link' : 'file') : 'absent'
  const diff: FileDiff = { before: `path: ${path}\nstate: ${before}\n`, after: `path: ${path}\nstate: ${state === 'touch' ? 'file' : state}\n`, before_header: path, after_header: path }
  try {
    if (state === 'absent') {
      if (!st.exists) return { changed: false, path, state: 'absent' }
      if (!m.check) {
        if (st.type === 'dir') t.sys.vfs.removeTree(path, t.cred)
        else t.sys.vfs.unlink(path, t.cred)
      }
      return { changed: true, path, state: 'absent', diff }
    }
    if (state === 'file') {
      if (!st.exists) return { failed: true, changed: false, path, state: 'absent', msg: `file (${path}) is absent, cannot continue` }
      const a = applyAttrs(m, path, m.check)
      if (a.error) return { failed: true, changed: false, msg: a.error, path }
      return { ...fileResult(t, path), changed: a.changed }
    }
    if (state === 'directory') {
      let changed = false
      if (st.exists && st.type !== 'dir') return { failed: true, changed: false, path, msg: `${path} already exists as a ${st.type === 'symlink' ? 'link' : 'file'}` }
      if (!st.exists) {
        changed = true
        if (!m.check) t.sys.vfs.mkdirp(path, t.cred, 0o755)
      }
      const a = applyAttrs(m, path, m.check)
      if (a.error) return { failed: true, changed: false, msg: a.error, path }
      if (bool(m.args.recurse) && !m.check && info(t, path).exists) {
        const walk = (p: string) => {
          for (const e of t.sys.vfs.readdir(p, ROOT_CRED)) {
            const c = `${p}/${e}`
            const s = info(t, c, false)
            const sub = applyAttrs({ ...m, args: { ...m.args, mode: s.type === 'dir' ? m.args.mode : m.args.mode } }, c, false)
            if (sub.changed) changed = true
            if (s.type === 'dir') walk(c)
          }
        }
        walk(path)
      }
      return { ...(m.check && !st.exists ? { path, state: 'absent' } : fileResult(t, path)), changed: changed || a.changed, ...(changed ? { diff } : {}) }
    }
    if (state === 'touch') {
      if (!m.check) {
        if (!st.exists) t.sys.vfs.writeFile(path, '', t.cred)
        else t.sys.vfs.touch(path, t.cred)
      }
      applyAttrs(m, path, m.check)
      return { ...fileResult(t, path), changed: true, diff }
    }
    if (state === 'link') {
      const src = str(m.args.src)
      if (!src) throw new ModuleArgError('src is required for creating new symlinks')
      if (st.exists && st.type === 'symlink' && t.sys.vfs.stat(path, ROOT_CRED, false).data === src) return { changed: false, path, src, state: 'link' }
      if (st.exists && st.type !== 'symlink' && !bool(m.args.force)) return { failed: true, changed: false, path, msg: `refusing to convert from ${before} to symlink for ${path}` }
      if (!m.check) {
        if (st.exists) t.sys.vfs.unlink(path, t.cred)
        t.sys.vfs.symlink(src, path, t.cred)
      }
      return { changed: true, path, src, state: 'link', diff }
    }
    return { failed: true, changed: false, msg: `state ${state} no está simulado` }
  } catch (e) {
    return { failed: true, changed: false, path, msg: `There was an issue creating ${path} as requested: ${fsMessage(e, path)}` }
  }
}

function readTarget(m: ModuleCtx, path: string): { text?: string; error?: Result } {
  const st = info(m.t, path)
  if (!st.exists) return {}
  try {
    return { text: m.t.sys.vfs.readFile(path, m.t.cred) }
  } catch (e) {
    return { error: { failed: true, changed: false, msg: `Error while reading ${path}: ${fsMessage(e, path)}` } }
  }
}

function pyRegex(s: string): RegExp {
  return new RegExp(s.replace(/\(\?P<(\w+)>/g, '(?<$1>').replace(/\\A/g, '^').replace(/\\Z/g, '$'))
}

const lineinfileModule: ModuleFn = async (m) => {
  const path = str(m.args.path ?? m.args.dest ?? m.args.destfile ?? m.args.name)
  if (!path) throw new ModuleArgError('missing required arguments: path')
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const regexp = str(m.args.regexp ?? m.args.regex)
  const search = str(m.args.search_string)
  const line = str(m.args.line ?? m.args.value)
  const r = readTarget(m, path)
  if (r.error) return r.error
  if (r.text === undefined) {
    if (state === 'absent') return { changed: false, found: 0, msg: '' }
    if (!bool(m.args.create)) return { failed: true, changed: false, rc: 257, msg: `Destination ${path} does not exist !` }
  }
  if (state === 'present' && line === undefined) throw new ModuleArgError('state is present but all of the following are missing: line')
  const text = r.text ?? ''
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const matches = (l: string) => (regexp !== undefined ? pyRegex(regexp).test(l) : search !== undefined ? l.includes(search) : l === line)
  let msg = ''
  let changed = false
  if (state === 'absent') {
    const keep = lines.filter((l) => !matches(l))
    const found = lines.length - keep.length
    if (!found) return { changed: false, found: 0, msg: '' }
    return writeContent(m, path, keep.join('\n') + (keep.length ? '\n' : ''), `${path} (content)`, { backup: bool(m.args.backup), validate: str(m.args.validate) }).then((res) => ({ ...res, found, msg: `${found} line(s) removed` }))
  }
  let idx = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (matches(lines[i])) {
      idx = i
      break
    }
  let newLine = line!
  if (idx >= 0) {
    if (bool(m.args.backrefs) && regexp) newLine = lines[idx].replace(pyRegex(regexp), line!.replace(/\\(\d)/g, '$$$1').replace(/\\g<(\w+)>/g, '$$<$1>'))
    if (lines[idx] !== newLine) {
      lines[idx] = newLine
      changed = true
      msg = 'line replaced'
    }
  } else if (bool(m.args.backrefs)) {
    return { changed: false, msg: '' }
  } else if (lines.includes(line!)) {
    // la línea exacta ya está
  } else {
    const after = str(m.args.insertafter)
    const before = str(m.args.insertbefore)
    let at = lines.length
    if (before === 'BOF') at = 0
    else if (before) {
      const i = lines.findIndex((l) => pyRegex(before).test(l))
      if (i >= 0) at = i
    } else if (after && after !== 'EOF') {
      let found = -1
      for (let i = lines.length - 1; i >= 0; i--)
        if (pyRegex(after).test(lines[i])) {
          found = i
          break
        }
      if (found >= 0) at = found + 1
    }
    lines.splice(at, 0, line!)
    changed = true
    msg = 'line added'
  }
  if (!changed) {
    const a = applyAttrs(m, path, m.check)
    if (a.error) return { failed: true, changed: false, msg: a.error }
    return { changed: a.changed, msg: a.changed ? 'ownership, perms or SE linux context changed' : '', backup: '' }
  }
  const res = await writeContent(m, path, lines.join('\n') + '\n', `${path} (content)`, { backup: bool(m.args.backup), validate: str(m.args.validate) })
  if (res.diff && Array.isArray(res.diff) && res.diff[0]) res.diff[0].before_header = `${path} (content)`
  return { ...res, msg: res.failed ? res.msg : msg }
}

const blockinfileModule: ModuleFn = async (m) => {
  const path = str(m.args.path ?? m.args.dest)
  if (!path) throw new ModuleArgError('missing required arguments: path')
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const block = str(m.args.block ?? m.args.content) ?? ''
  const marker = str(m.args.marker) ?? '# {mark} ANSIBLE MANAGED BLOCK'
  const begin = marker.replace('{mark}', str(m.args.marker_begin) ?? 'BEGIN')
  const end = marker.replace('{mark}', str(m.args.marker_end) ?? 'END')
  const r = readTarget(m, path)
  if (r.error) return r.error
  if (r.text === undefined && !bool(m.args.create)) return { failed: true, changed: false, rc: 257, msg: `Path ${path} does not exist !` }
  const lines = (r.text ?? '').replace(/\n$/, '').split('\n').filter((l, _i, a) => !(a.length === 1 && l === ''))
  const b = lines.indexOf(begin)
  const e = lines.indexOf(end)
  const blockLines = state === 'present' && block !== '' ? [begin, ...block.replace(/\n$/, '').split('\n'), end] : []
  const out = [...lines]
  if (b >= 0 && e > b) out.splice(b, e - b + 1, ...blockLines)
  else if (blockLines.length) {
    const after = str(m.args.insertafter)
    const before = str(m.args.insertbefore)
    let at = out.length
    if (before === 'BOF') at = 0
    else if (before) {
      const i = out.findIndex((l) => pyRegex(before).test(l))
      if (i >= 0) at = i
    } else if (after && after !== 'EOF') {
      const i = out.findIndex((l) => pyRegex(after).test(l))
      if (i >= 0) at = i + 1
    }
    out.splice(at, 0, ...blockLines)
  }
  const text = out.length ? out.join('\n') + '\n' : ''
  if (text === (r.text ?? '')) return { changed: false, msg: '' }
  const res = await writeContent(m, path, text, `${path} (content)`, { backup: bool(m.args.backup), validate: str(m.args.validate) })
  return { ...res, msg: res.failed ? res.msg : b >= 0 ? (blockLines.length ? 'Block inserted' : 'Block removed') : 'Block inserted' }
}

const replaceModule: ModuleFn = async (m) => {
  need(m, 'path', 'regexp')
  const path = String(m.args.path)
  const r = readTarget(m, path)
  if (r.error) return r.error
  if (r.text === undefined) return { failed: true, changed: false, rc: 257, msg: `Path ${path} does not exist !` }
  const re = new RegExp(pyRegex(String(m.args.regexp)).source, 'gm')
  const repl = (str(m.args.replace) ?? '').replace(/\\(\d)/g, '$$$1').replace(/\\g<(\w+)>/g, '$$<$1>')
  const count = (r.text.match(re) ?? []).length
  const text = r.text.replace(re, repl)
  if (text === r.text) return { changed: false, msg: '' }
  const res = await writeContent(m, path, text, `${path} (content)`, { backup: bool(m.args.backup), validate: str(m.args.validate) })
  return { ...res, msg: res.failed ? res.msg : `${count} replacements made` }
}

const statModule: ModuleFn = async (m) => {
  need(m, 'path')
  const path = String(m.args.path)
  const st = info(m.t, path, bool(m.args.follow))
  if (!st.exists) return { changed: false, stat: { exists: false } }
  const data = st.data ?? ''
  return {
    changed: false,
    stat: {
      exists: true,
      path,
      isdir: st.type === 'dir',
      isreg: st.type === 'file',
      islnk: st.type === 'symlink',
      mode: modeStr(st.mode ?? 0),
      uid: st.uid,
      gid: st.gid,
      pw_name: userName(m.t.sys, st.uid!),
      gr_name: m.t.sys.groupName(st.gid!),
      size: st.type === 'dir' ? 4096 : data.length,
      executable: ((st.mode ?? 0) & 0o111) !== 0,
      readable: true,
      writeable: m.t.cred.uid === 0 || st.uid === m.t.cred.uid,
      checksum: st.type === 'file' ? sha1ish(data) : undefined,
    },
  }
}

function sha1ish(s: string): string {
  let h = 0x811c9dc5
  let out = ''
  for (let r = 0; r < 5; r++) {
    for (const c of s + r) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Usuarios y accesos
// ---------------------------------------------------------------------------------------

const userModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const sys = m.t.sys
  const u = sys.users.get(name)
  if (m.t.cred.uid !== 0 && (state === 'absent' ? !!u : true)) {
    if (!u || state === 'absent') return { failed: true, changed: false, name, msg: `useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n`, rc: 1 }
  }
  if (state === 'absent') {
    if (!u) return { changed: false, name, state: 'absent' }
    if (!m.check) {
      const r = await m.t.exec(`userdel ${bool(m.args.remove) ? '-r ' : ''}${q(name)}`)
      if (r.rc !== 0) return { failed: true, changed: false, name, msg: r.stderr.trim(), rc: r.rc }
    }
    return { changed: true, name, state: 'absent', force: false, remove: bool(m.args.remove) }
  }
  const groups = list(m.args.groups)
  const append = bool(m.args.append)
  const shell = str(m.args.shell)
  const comment = str(m.args.comment)
  const home = str(m.args.home)
  const uid = m.args.uid === undefined ? undefined : Number(m.args.uid)
  const group = str(m.args.group)
  const password = str(m.args.password)
  const missingGroups = [...groups, ...(group ? [group] : [])].filter((g) => !sys.groups.has(g))
  if (missingGroups.length) return { failed: true, changed: false, name, msg: `Group ${missingGroups[0]} does not exist` }
  if (!u) {
    if (!m.check) {
      const parts = ['useradd']
      if (bool(m.args.system)) parts.push('-r')
      if (uid !== undefined) parts.push('-u', String(uid))
      if (group) parts.push('-g', q(group))
      if (groups.length) parts.push('-G', q(groups.join(',')))
      if (shell) parts.push('-s', q(shell))
      if (comment) parts.push('-c', q(comment))
      if (home) parts.push('-d', q(home))
      if (bool(m.args.create_home, true) && !bool(m.args.system)) parts.push('-m')
      else parts.push('-M')
      parts.push(q(name))
      const r = await m.t.exec(parts.join(' '))
      if (r.rc !== 0) return { failed: true, changed: false, name, msg: r.stderr.trim(), rc: r.rc }
      if (password) await m.t.exec(`usermod -p ${q(password)} ${q(name)}`)
    }
    const nu = sys.users.get(name)
    return { changed: true, name, state: 'present', uid: nu?.uid ?? uid, group: nu?.gid, groups: groups.join(','), home: nu?.home ?? home ?? `/home/${name}`, shell: nu?.shell ?? shell ?? '/bin/bash', comment: comment ?? '', create_home: bool(m.args.create_home, true), system: bool(m.args.system) }
  }
  const changes: string[] = []
  const current = sys.groupsOf(name).filter((g) => g !== sys.groupName(u.gid))
  if (groups.length || (m.args.groups !== undefined && !append)) {
    const target = append ? [...new Set([...current, ...groups])] : groups
    if ([...target].sort().join(',') !== [...current].sort().join(',')) changes.push(`-G ${q(target.join(','))}`)
  }
  if (shell && u.shell !== shell) changes.push(`-s ${q(shell)}`)
  if (comment !== undefined && u.gecos !== comment) changes.push(`-c ${q(comment)}`)
  if (home && u.home !== home) changes.push(`-d ${q(home)}${bool(m.args.move_home) ? ' -m' : ''}`)
  if (uid !== undefined && u.uid !== uid) changes.push(`-u ${uid}`)
  if (group && sys.groupName(u.gid) !== group) changes.push(`-g ${q(group)}`)
  let pwChanged = false
  if (password && (str(m.args.update_password) ?? 'always') === 'always') {
    let shadow = ''
    try {
      shadow = sys.vfs.readFile('/etc/shadow', ROOT_CRED).split('\n').find((l) => l.startsWith(`${name}:`))?.split(':')[1] ?? ''
    } catch {
      // sin shadow
    }
    if (shadow !== password) pwChanged = true
  }
  if (!changes.length && !pwChanged) return { changed: false, name, state: 'present', uid: u.uid, group: u.gid, home: u.home, shell: u.shell, append, comment: u.gecos }
  if (!m.check) {
    if (changes.length) {
      const r = await m.t.exec(`usermod ${changes.join(' ')} ${q(name)}`)
      if (r.rc !== 0) return { failed: true, changed: false, name, msg: r.stderr.trim(), rc: r.rc }
    }
    if (pwChanged) await m.t.exec(`usermod -p ${q(password!)} ${q(name)}`)
  }
  return { changed: true, name, state: 'present', append, uid: u.uid, home: u.home, shell: shell ?? u.shell, ...(pwChanged ? { password: 'NOT_LOGGING_PASSWORD' } : {}) }
}

const groupModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const exists = m.t.sys.groups.has(name)
  if (state === 'present' ? exists : !exists) return { changed: false, name, state, gid: m.t.sys.groups.get(name)?.gid, system: bool(m.args.system) }
  if (!m.check) {
    const r = await m.t.exec(state === 'present' ? `groupadd ${bool(m.args.system) ? '-r ' : ''}${m.args.gid !== undefined ? `-g ${Number(m.args.gid)} ` : ''}${q(name)}` : `groupdel ${q(name)}`)
    if (r.rc !== 0) return { failed: true, changed: false, name, msg: r.stderr.trim() }
  }
  return { changed: true, name, state, gid: m.t.sys.groups.get(name)?.gid, system: bool(m.args.system) }
}

const authorizedKeyModule: ModuleFn = async (m) => {
  need(m, 'user', 'key')
  const user = String(m.args.user)
  const u = m.t.sys.users.get(user)
  if (!u) return { failed: true, changed: false, msg: `Failed to lookup user ${user}: "getpwnam(): name not found: '${user}'"` }
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const keys = String(m.args.key)
    .split('\n')
    .map((k) => k.trim())
    .filter(Boolean)
  const dir = `${u.home}/.ssh`
  const path = String(m.args.path ?? `${dir}/authorized_keys`)
  const cur = info(m.t, path).exists ? m.t.sys.vfs.readFile(path, ROOT_CRED) : ''
  const lines = cur.split('\n').filter(Boolean)
  const body = (k: string) => k.split(/\s+/).slice(0, 2).join(' ')
  let next = [...lines]
  if (state === 'present') {
    if (bool(m.args.exclusive)) next = keys
    else for (const k of keys) if (!next.some((l) => body(l) === body(k))) next.push(k)
  } else next = lines.filter((l) => !keys.some((k) => body(k) === body(l)))
  const text = next.length ? next.join('\n') + '\n' : ''
  if (text === cur) return { changed: false, user, key: m.args.key, path, state }
  if (!m.check) {
    if (m.t.cred.uid !== 0 && m.t.cred.uid !== u.uid) return { failed: true, changed: false, msg: `Failed to write to file ${path}: [Errno 13] Permission denied` }
    if (!info(m.t, dir).exists) {
      m.t.sys.vfs.mkdirp(dir, ROOT_CRED, 0o700)
      m.t.sys.vfs.chown(dir, u.uid, u.gid, ROOT_CRED)
    }
    m.t.sys.vfs.writeFile(path, text, ROOT_CRED, { mode: 0o600 })
    m.t.sys.vfs.chmod(path, 0o600, ROOT_CRED)
    m.t.sys.vfs.chown(path, u.uid, u.gid, ROOT_CRED)
  }
  return { changed: true, user, key: m.args.key, path, state, diff: { before: cur, after: text, before_header: path, after_header: path } }
}

// ---------------------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------------------

/** k=v sueltos dentro de un comando en forma libre (chdir=, creates=, removes=). */
export function splitFreeForm(raw: string): { cmd: string; opts: Record<string, string> } {
  const opts: Record<string, string> = {}
  const cmd = raw
    .replace(/(^|\s)(chdir|creates|removes|executable|warn|stdin)=("[^"]*"|'[^']*'|\S+)/g, (_m, sp, k, v) => {
      opts[k] = v.replace(/^['"]|['"]$/g, '')
      return sp
    })
    .trim()
  return { cmd, opts }
}

function shellSplit(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(s))) out.push(mm[1] !== undefined ? mm[1].replace(/\\(.)/g, '$1') : (mm[2] ?? mm[3]))
  return out
}

async function commandModule(m: ModuleCtx, useShell: boolean): Promise<Result> {
  const free = str(m.args._raw_params)
  const argv = m.args.argv as string[] | undefined
  let cmd = str(m.args.cmd) ?? free ?? ''
  const opts: Record<string, string> = {}
  if (free) Object.assign(opts, splitFreeForm(free).opts)
  if (free) cmd = splitFreeForm(free).cmd
  for (const k of ['chdir', 'creates', 'removes', 'stdin']) if (m.args[k] !== undefined) opts[k] = String(m.args[k])
  if (argv) cmd = argv.map(q).join(' ')
  if (!cmd.trim()) return { failed: true, changed: false, rc: 256, msg: 'no command given' }
  const start = new Date()
  if (opts.creates && info(m.t, opts.creates).exists) return { changed: false, cmd, rc: 0, stdout: `skipped, since ${opts.creates} exists`, stderr: '', msg: 'Did not run command since path exists' }
  if (opts.removes && !info(m.t, opts.removes).exists) return { changed: false, cmd, rc: 0, stdout: `skipped, since ${opts.removes} does not exist`, stderr: '', msg: 'Did not run command since path does not exist' }
  if (m.check) return { changed: false, skipped: true, msg: 'Command would have run if not in check mode' }
  // command no pasa por una shell: tuberías, redirecciones y variables llegan como argumentos.
  const line = useShell ? cmd : shellSplit(cmd).map(q).join(' ')
  const full = opts.chdir ? `cd ${q(opts.chdir)} && ${line}` : line
  const r = await m.t.exec(full, opts.stdin)
  const end = new Date()
  const res: Result = {
    changed: true,
    cmd: useShell ? cmd : shellSplit(cmd),
    rc: r.rc,
    stdout: r.stdout.replace(/\n$/, ''),
    stderr: r.stderr.replace(/\n$/, ''),
    stdout_lines: r.stdout.replace(/\n$/, '').split('\n').filter((l, _i, a) => !(a.length === 1 && l === '')),
    stderr_lines: r.stderr.replace(/\n$/, '').split('\n').filter((l, _i, a) => !(a.length === 1 && l === '')),
    start: start.toISOString().replace('T', ' ').replace('Z', ''),
    end: end.toISOString().replace('T', ' ').replace('Z', ''),
    delta: '0:00:00.004512',
    msg: '',
  }
  if (r.rc !== 0) {
    res.failed = true
    res.msg = r.rc === 127 && /command not found|No such file/.test(r.stderr) ? `[Errno 2] No such file or directory: b'${shellSplit(cmd)[0]}'` : 'non-zero return code'
    if (r.rc === 127 && !useShell) {
      res.rc = 2
      res.cmd = shellSplit(cmd)[0]
    }
  }
  return res
}

const rawModule: ModuleFn = async (m) => {
  const cmd = str(m.args._raw_params) ?? ''
  if (m.check) return { changed: false, skipped: true, msg: 'This action (raw) does not support check mode.' }
  const r = await m.t.exec(cmd)
  return { changed: true, rc: r.rc, stdout: r.stdout, stdout_lines: r.stdout.split('\n').filter(Boolean), stderr: r.stderr, ...(r.rc !== 0 ? { failed: true, msg: 'non-zero return code' } : {}) }
}

// ---------------------------------------------------------------------------------------
// Red, firewall y sistema
// ---------------------------------------------------------------------------------------

const firewalldModule: ModuleFn = async (m) => {
  const sys = m.t.sys
  if (!sys.installed.has('firewalld')) return { failed: true, changed: false, msg: 'Python Module not found: firewalld and its python module are required for this module,                         version 0.2.11 or newer required (0.3.9 or newer for offline operations)' }
  const state = choices(m, 'state', ['enabled', 'disabled', 'present', 'absent'])
  if (!state) throw new ModuleArgError('missing required arguments: state')
  const zone = str(m.args.zone)
  const z = zone ? ` --zone=${zone}` : ''
  let what: string
  let item: string
  if (m.args.service !== undefined) {
    what = 'service'
    item = String(m.args.service)
  } else if (m.args.port !== undefined) {
    what = 'port'
    item = String(m.args.port)
  } else if (m.args.source !== undefined) {
    what = 'source'
    item = String(m.args.source)
  } else if (m.args.rich_rule !== undefined) {
    what = 'rich-rule'
    item = String(m.args.rich_rule)
  } else return { failed: true, changed: false, msg: 'One of service, port, source, rich_rule, interface, masquerade, icmp_block, icmp_block_inversion, target or port_forward is required' }
  if (m.t.cred.uid !== 0) return { failed: true, changed: false, msg: 'ERROR: Exception caught: org.fedoraproject.FirewallD1.Exception: ACCESS_DENIED' }
  if (what === 'port' && !/^\d+(-\d+)?\/(tcp|udp|sctp|dccp)$/.test(item)) return { failed: true, changed: false, msg: `improper port format (missing protocol?)` }
  const permanent = bool(m.args.permanent)
  const immediate = bool(m.args.immediate) || !permanent
  const want = state === 'enabled' || state === 'present'
  const arg = `${what}=${q(item)}`
  const queries = [...(permanent ? ['--permanent'] : []), ...(immediate && permanent ? [''] : [])]
  if (!permanent) queries.splice(0, queries.length, '')
  let changed = false
  for (const p of queries) {
    const r = await m.t.exec(`firewall-cmd${z}${p ? ' ' + p : ''} --query-${arg}`)
    const has = r.rc === 0
    if (has !== want) {
      changed = true
      if (!m.check) {
        const res = await m.t.exec(`firewall-cmd${z}${p ? ' ' + p : ''} --${want ? 'add' : 'remove'}-${arg}`)
        if (res.rc !== 0) return { failed: true, changed: false, msg: `ERROR: Exception caught: ${res.stderr.trim()}` }
      }
    }
  }
  const msg = changed ? `${permanent ? 'Permanent' : 'Non-permanent'} operation${permanent && immediate ? ', Changed ' + what + ' ' + item + ' to ' + state : ''}` : `${permanent ? 'Permanent' : 'Non-permanent'} operation`
  return { changed, msg }
}

const ufwModule: ModuleFn = async (m) => {
  if (!m.t.sys.installed.has('ufw')) return { failed: true, changed: false, msg: 'Failed to find required executable "ufw" in paths: /usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin' }
  if (m.t.cred.uid !== 0) return { failed: true, changed: false, msg: 'ERROR: You need to be root to run this script' }
  const status = (await m.t.exec('ufw status')).stdout
  let changed = false
  const state = str(m.args.state)
  if (state === 'enabled' || state === 'disabled') {
    const on = /Status: active/.test(status)
    if (on !== (state === 'enabled')) {
      changed = true
      if (!m.check) await m.t.exec(state === 'enabled' ? 'ufw --force enable' : 'ufw disable')
    }
  }
  const rule = str(m.args.rule)
  if (rule) {
    const port = str(m.args.port ?? m.args.to_port)
    const proto = str(m.args.proto)
    const from = str(m.args.from_ip ?? m.args.src)
    const spec = from ? `from ${from} to any${port ? ` port ${port}` : ''}${proto ? ` proto ${proto}` : ''}` : `${port ?? ''}${proto ? `/${proto}` : ''}`
    const shown = port ? `${port}${proto ? `/${proto}` : ''}` : ''
    const present = shown ? new RegExp(`^${shown.replace(/\//g, '\\/')}\\s+${rule.toUpperCase()}`, 'm').test(status) : false
    const del = bool(m.args.delete)
    if (present === del) {
      changed = true
      if (!m.check) await m.t.exec(`ufw ${del ? 'delete ' : ''}${rule} ${spec}`)
    }
  }
  return { changed, commands: [], msg: 'Status: active' }
}

const cronModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const user = str(m.args.user) ?? m.t.user
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const job = str(m.args.job)
  if (state === 'present' && !job && !bool(m.args.env)) throw new ModuleArgError('You must specify \'job\' to install a new cron job or variable')
  const r = await m.t.exec(`crontab -l -u ${q(user)}`)
  const cur = r.rc === 0 ? r.stdout : ''
  const lines = cur.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''))
  const marker = `#Ansible: ${name}`
  const i = lines.indexOf(marker)
  const spec = str(m.args.special_time) ? `@${m.args.special_time}` : ['minute', 'hour', 'day', 'month', 'weekday'].map((k) => str(m.args[k]) ?? '*').join(' ')
  const entry = state === 'present' ? [marker, `${bool(m.args.disabled) ? '#' : ''}${spec} ${job}`] : []
  const next = [...lines]
  if (i >= 0) next.splice(i, 2, ...entry)
  else next.push(...entry)
  const text = next.length ? next.join('\n') + '\n' : ''
  if (text === (cur.endsWith('\n') || !cur ? cur : cur + '\n')) return { changed: false, jobs: lines.filter((l) => l.startsWith('#Ansible: ')).map((l) => l.slice(10)), envs: [] }
  if (!m.check) {
    const tmp = `/tmp/.ansible_cron_${user}`
    m.t.sys.vfs.writeFile(tmp, text, ROOT_CRED, { mode: 0o644 })
    const w = await m.t.exec(`crontab -u ${q(user)} ${tmp}`)
    try {
      m.t.sys.vfs.unlink(tmp, ROOT_CRED)
    } catch {
      // ya no está
    }
    if (w.rc !== 0) return { failed: true, changed: false, msg: w.stderr.trim() || 'crontab failed' }
  }
  return { changed: true, jobs: next.filter((l) => l.startsWith('#Ansible: ')).map((l) => l.slice(10)), envs: [], diff: { before: cur, after: text, before_header: `crontab for user "${user}"`, after_header: `crontab for user "${user}"` } }
}

const hostnameModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  if (m.t.sys.hostname === name) return { changed: false, name, ansible_facts: { ansible_hostname: name.split('.')[0], ansible_fqdn: name } }
  if (m.t.cred.uid !== 0) return { failed: true, changed: false, msg: 'Command failed rc=1, out=, err=Could not set static hostname: Access denied' }
  if (!m.check) await m.t.exec(`hostnamectl set-hostname ${q(name)}`)
  return { changed: true, name, ansible_facts: { ansible_hostname: name.split('.')[0], ansible_nodename: name, ansible_fqdn: name } }
}

const timezoneModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  if (m.t.sys.clock.timezone === name) return { changed: false, diff: { before: { name }, after: { name } } as unknown as FileDiff }
  if (!m.check) {
    const r = await m.t.exec(`timedatectl set-timezone ${q(name)}`)
    if (r.rc !== 0) return { failed: true, changed: false, msg: r.stderr.trim() }
  }
  return { changed: true }
}

const sysctlModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const value = str(m.args.value)
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const file = str(m.args.sysctl_file) ?? '/etc/sysctl.conf'
  const cur = info(m.t, file).exists ? m.t.sys.vfs.readFile(file, ROOT_CRED) : ''
  const lines = cur.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''))
  const re = new RegExp(`^\\s*${name.replace(/\./g, '\\.')}\\s*=`)
  const idx = lines.findIndex((l) => re.test(l))
  const next = [...lines]
  if (state === 'present') {
    if (value === undefined) throw new ModuleArgError('value is required when state is present')
    const line = `${name}=${value}`
    if (idx >= 0) next[idx] = line
    else next.push(line)
  } else if (idx >= 0) next.splice(idx, 1)
  const text = next.length ? next.join('\n') + '\n' : ''
  const changed = text !== (cur.endsWith('\n') || !cur ? cur : cur + '\n')
  if (changed && !m.check) {
    if (m.t.cred.uid !== 0) return { failed: true, changed: false, msg: `Failed to write to file ${file}: [Errno 13] Permission denied` }
    m.t.sys.vfs.writeFile(file, text, ROOT_CRED)
    if (state === 'present' && bool(m.args.sysctl_set, true) !== false && bool(m.args.reload, true)) await m.t.exec(`sysctl -w ${q(`${name}=${value}`)}`)
  }
  return { changed }
}

const seleniumBoolean: ModuleFn = async (m) => {
  need(m, 'name', 'state')
  if (m.t.sys.distro === 'ubuntu') return { failed: true, changed: false, msg: 'Failed to import the required Python library (libselinux-python) on host. Please read the module documentation and install it in the appropriate location.' }
  const name = String(m.args.name)
  const state = bool(m.args.state)
  const r = await m.t.exec(`getsebool ${q(name)}`)
  if (r.rc !== 0) return { failed: true, changed: false, msg: `SELinux boolean ${name} does not exist.` }
  const cur = /-->\s*on/.test(r.stdout)
  if (cur === state) return { changed: false, name, state, persistent: bool(m.args.persistent) }
  if (!m.check) await m.t.exec(`setsebool ${bool(m.args.persistent) ? '-P ' : ''}${q(name)} ${state ? 'on' : 'off'}`)
  return { changed: true, name, state, persistent: bool(m.args.persistent) }
}

const selinuxModule: ModuleFn = async (m) => {
  const state = choices(m, 'state', ['enforcing', 'permissive', 'disabled'])
  if (!state) throw new ModuleArgError('missing required arguments: state')
  if (m.t.sys.distro === 'ubuntu') return { failed: true, changed: false, msg: 'Failed to import the required Python library (libselinux-python) on host.' }
  const cfg = info(m.t, '/etc/selinux/config').exists ? m.t.sys.vfs.readFile('/etc/selinux/config', ROOT_CRED) : 'SELINUX=enforcing\n'
  const cur = /^SELINUX=(\w+)/m.exec(cfg)?.[1]
  const runtime = (await m.t.exec('getenforce')).stdout.trim().toLowerCase()
  let changed = false
  if (cur !== state) {
    changed = true
    if (!m.check) m.t.sys.vfs.writeFile('/etc/selinux/config', cfg.replace(/^SELINUX=\w+/m, `SELINUX=${state}`), ROOT_CRED)
  }
  if (state !== 'disabled' && runtime !== 'disabled' && runtime !== state) {
    changed = true
    if (!m.check) await m.t.exec(`setenforce ${state === 'enforcing' ? 1 : 0}`)
  }
  const reboot = state === 'disabled' || runtime === 'disabled'
  return { changed, msg: changed ? `Config SELinux state changed from '${cur}' to '${state}'` : '', policy: 'targeted', state, configfile: '/etc/selinux/config', reboot_required: reboot && changed }
}

const waitForModule: ModuleFn = async (m) => {
  const port = m.args.port !== undefined ? Number(m.args.port) : undefined
  const path = str(m.args.path)
  const timeout = Number(m.args.timeout ?? 300)
  if (path) {
    const ok = info(m.t, path).exists
    return ok ? { changed: false, path, elapsed: 0 } : { failed: true, changed: false, elapsed: timeout, msg: `Timeout when waiting for file ${path}` }
  }
  if (port === undefined) return { changed: false, elapsed: Number(m.args.delay ?? 0) }
  const r = await m.t.exec('ss -ltnH')
  const listening = new RegExp(`:${port}\\s`).test(r.stdout + ' ')
  const want = (str(m.args.state) ?? 'started') !== 'stopped'
  if (listening === want) return { changed: false, port, elapsed: 0, state: want ? 'started' : 'stopped', match_groupdict: {}, match_groups: [], path: null, search_regex: null }
  return { failed: true, changed: false, elapsed: timeout, msg: `Timeout when waiting for ${str(m.args.host) ?? '127.0.0.1'}:${port}` }
}

const uriModule: ModuleFn = async (m) => {
  need(m, 'url')
  const url = String(m.args.url)
  const method = String(m.args.method ?? 'GET').toUpperCase()
  const expected = (Array.isArray(m.args.status_code) ? m.args.status_code : [m.args.status_code ?? 200]).map(Number)
  const r = await m.t.exec(`curl -s -k -X ${method} -o /tmp/.ansible_uri -w '%{http_code}' ${bool(m.args.validate_certs, true) ? '' : '-k '}${q(url)}`)
  let body = ''
  try {
    body = m.t.sys.vfs.readFile('/tmp/.ansible_uri', ROOT_CRED)
    m.t.sys.vfs.unlink('/tmp/.ansible_uri', ROOT_CRED)
  } catch {
    // sin cuerpo
  }
  const status = Number(r.stdout.trim()) || -1
  const base: Result = { changed: false, url, status, msg: status > 0 ? `OK (${body.length} bytes)` : `Status code was -1 and not [${expected.join(', ')}]: Request failed: <urlopen error [Errno 111] Connection refused>`, redirected: false, elapsed: 0 }
  if (bool(m.args.return_content)) base.content = body
  if (/json/.test(body.trimStart().slice(0, 1) === '{' || body.trimStart().slice(0, 1) === '[' ? 'json' : '')) {
    try {
      base.json = JSON.parse(body)
    } catch {
      // no era JSON
    }
  }
  if (!expected.includes(status)) return { ...base, failed: true, msg: status > 0 ? `Status code was ${status} and not [${expected.join(', ')}]: HTTP Error ${status}` : base.msg }
  return base
}

const getUrlModule: ModuleFn = async (m) => {
  need(m, 'url', 'dest')
  const url = String(m.args.url)
  const dest = String(m.args.dest)
  if (info(m.t, dest).exists && !bool(m.args.force)) return { changed: false, url, dest, msg: 'file already exists' }
  if (m.check) return { changed: true, url, dest, msg: 'file would be downloaded' }
  const r = await m.t.exec(`curl -sfL -o ${q(dest)} ${q(url)}`)
  if (r.rc !== 0) return { failed: true, changed: false, url, dest, msg: `Request failed: <urlopen error [Errno -2] Name or service not known>`, status_code: -1 }
  applyAttrs(m, dest, false)
  return { ...fileResult(m.t, dest), changed: true, url, dest, msg: 'OK', status_code: 200 }
}

const gitModule: ModuleFn = async (m) => {
  need(m, 'repo', 'dest')
  const repo = String(m.args.repo)
  const dest = String(m.args.dest)
  const version = str(m.args.version) ?? 'HEAD'
  if (!m.t.sys.installed.has('git')) return { failed: true, changed: false, msg: 'Failed to find required executable "git" in paths: /usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin' }
  const exists = info(m.t, `${dest}/.git`).exists
  if (m.check) return { changed: !exists, before: exists ? 'actual' : null, after: 'remote' }
  if (!exists) {
    const r = await m.t.exec(`git clone ${q(repo)} ${q(dest)}${version !== 'HEAD' ? ` && git -C ${q(dest)} checkout -q ${q(version)}` : ''}`)
    if (r.rc !== 0) return { failed: true, changed: false, msg: `Failed to download remote objects and refs:  ${r.stderr.trim()}`, cmd: `/usr/bin/git clone --origin origin '' ${dest}` }
    const after = (await m.t.exec(`git -C ${q(dest)} rev-parse HEAD`)).stdout.trim()
    return { changed: true, before: null, after }
  }
  const before = (await m.t.exec(`git -C ${q(dest)} rev-parse HEAD`)).stdout.trim()
  await m.t.exec(`git -C ${q(dest)} pull -q`)
  const after = (await m.t.exec(`git -C ${q(dest)} rev-parse HEAD`)).stdout.trim()
  return { changed: before !== after, before, after, remote_url_changed: false }
}

// ---------------------------------------------------------------------------------------
// Bases de datos (community.postgresql y community.mysql)
// ---------------------------------------------------------------------------------------

async function sql(m: ModuleCtx, engine: 'pg' | 'my', statement: string, db?: string) {
  // Con become_user: postgres (lo habitual) el módulo ya corre como postgres y entra por peer.
  const asPg = m.t.user === 'postgres' ? '' : 'sudo -u postgres '
  const cmd = engine === 'pg' ? `${asPg}psql -tAqX ${db ? `-d ${q(db)} ` : ''}-c ${q(statement)}` : `mysql -N -B ${db ? `${q(db)} ` : ''}-e ${q(statement)}`
  return m.t.exec(cmd)
}

const pgDbModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const state = choices(m, 'state', ['present', 'absent', 'dump', 'restore'], 'present')!
  const ex = await sql(m, 'pg', `SELECT 1 FROM pg_database WHERE datname='${name}'`)
  if (ex.rc !== 0) return { failed: true, changed: false, msg: `unable to connect to database: ${ex.stderr.trim() || 'connection to server on socket "/run/postgresql/.s.PGSQL.5432" failed: No such file or directory'}` }
  const has = ex.stdout.trim() === '1'
  if ((state === 'present') === has) return { changed: false, db: name, executed_commands: [] }
  const stmt = state === 'present' ? `CREATE DATABASE "${name}"${m.args.owner ? ` OWNER "${m.args.owner}"` : ''}` : `DROP DATABASE "${name}"`
  if (!m.check) {
    const r = await sql(m, 'pg', stmt)
    if (r.rc !== 0) return { failed: true, changed: false, msg: `Database query failed: ${r.stderr.trim()}` }
  }
  return { changed: true, db: name, executed_commands: [stmt] }
}

const pgUserModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const ex = await sql(m, 'pg', `SELECT 1 FROM pg_roles WHERE rolname='${name}'`)
  if (ex.rc !== 0) return { failed: true, changed: false, msg: `unable to connect to database: ${ex.stderr.trim()}` }
  const has = ex.stdout.trim() === '1'
  const cmds: string[] = []
  if (state === 'absent') {
    if (has) cmds.push(`DROP USER "${name}"`)
  } else if (!has) cmds.push(`CREATE USER "${name}"${m.args.password ? ` WITH PASSWORD '${m.args.password}'` : ''}`)
  if (!cmds.length) return { changed: false, user: name, queries: [] }
  if (!m.check) for (const c of cmds) {
    const r = await sql(m, 'pg', c)
    if (r.rc !== 0) return { failed: true, changed: false, msg: r.stderr.trim() }
  }
  return { changed: true, user: name, queries: cmds.map((c) => c.replace(/PASSWORD '[^']*'/, "PASSWORD '********'")) }
}

const pgPrivsModule: ModuleFn = async (m) => {
  const db = str(m.args.database ?? m.args.db ?? m.args.login_db)
  const roles = str(m.args.roles ?? m.args.role)
  const privs = str(m.args.privs ?? m.args.priv) ?? 'ALL'
  const type = str(m.args.type) ?? 'table'
  if (!db || !roles) throw new ModuleArgError('missing required arguments: database, roles')
  const stmt = type === 'database' ? `GRANT ${privs} ON DATABASE "${db}" TO "${roles}"` : `GRANT ${privs} ON ALL TABLES IN SCHEMA public TO "${roles}"`
  if (!m.check) {
    const r = await sql(m, 'pg', stmt, type === 'database' ? undefined : db)
    if (r.rc !== 0) return { failed: true, changed: false, msg: r.stderr.trim() }
  }
  return { changed: true, queries: [stmt] }
}

const myDbModule: ModuleFn = async (m) => {
  need(m, 'name')
  const names = list(m.args.name)
  const state = choices(m, 'state', ['present', 'absent', 'dump', 'import'], 'present')!
  const ex = await sql(m, 'my', 'SHOW DATABASES')
  if (ex.rc !== 0) return { failed: true, changed: false, msg: `unable to find /root/.my.cnf. Exception message: (2002, "Can't connect to local server through socket '/var/lib/mysql/mysql.sock' (2)")` }
  const have = ex.stdout.split('\n').map((l) => l.trim())
  const todo = names.filter((n) => (state === 'present' ? !have.includes(n) : have.includes(n)))
  if (!todo.length) return { changed: false, db: names.join(','), db_list: names, executed_commands: [] }
  const cmds = todo.map((n) => (state === 'present' ? `CREATE DATABASE \`${n}\`` : `DROP DATABASE \`${n}\``))
  if (!m.check) for (const c of cmds) await sql(m, 'my', c)
  return { changed: true, db: names.join(','), db_list: names, executed_commands: cmds }
}

const myUserModule: ModuleFn = async (m) => {
  need(m, 'name')
  const name = String(m.args.name)
  const host = str(m.args.host) ?? 'localhost'
  const state = choices(m, 'state', ['present', 'absent'], 'present')!
  const ex = await sql(m, 'my', `SELECT COUNT(*) FROM mysql.user WHERE user='${name}' AND host='${host}'`)
  if (ex.rc !== 0) return { failed: true, changed: false, msg: `unable to connect to database, check login_user and login_password are correct or /root/.my.cnf has the credentials. Exception message: (1045, "Access denied for user 'root'@'localhost'")` }
  const has = Number(ex.stdout.trim()) > 0
  const cmds: string[] = []
  if (state === 'absent' && has) cmds.push(`DROP USER '${name}'@'${host}'`)
  if (state === 'present') {
    if (!has) cmds.push(`CREATE USER '${name}'@'${host}'${m.args.password ? ` IDENTIFIED BY '${m.args.password}'` : ''}`)
    const priv = str(m.args.priv)
    if (priv && !has) {
      for (const p of priv.split('/')) {
        const [obj, perms] = p.split(':')
        if (obj && perms) cmds.push(`GRANT ${perms} ON ${obj.replace(/^([^.]+)\./, '`$1`.')} TO '${name}'@'${host}'`)
      }
    }
  }
  if (!cmds.length) return { changed: false, user: name, msg: 'User unchanged' }
  if (!m.check) for (const c of cmds) await sql(m, 'my', c)
  return { changed: true, user: name, msg: state === 'present' ? (has ? 'Privileges updated' : 'User added') : 'User deleted' }
}

// ---------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------

/** Los módulos que se ejecutan en el equipo, por nombre corto. */
export const REMOTE_MODULES: Record<string, ModuleFn> = {
  ping: async (m) => (m.args.data === 'crash' ? { failed: true, changed: false, msg: 'boom' } : { changed: false, ping: str(m.args.data) ?? 'pong' }),
  package: (m) => packageModule(m, 'auto'),
  dnf: (m) => packageModule(m, 'dnf'),
  dnf5: (m) => packageModule(m, 'dnf'),
  yum: (m) => packageModule(m, 'dnf'),
  apt: (m) => packageModule(m, 'apt'),
  service: serviceModule,
  systemd: serviceModule,
  systemd_service: serviceModule,
  copy: copyModule,
  template: templateModule,
  file: fileModule,
  lineinfile: lineinfileModule,
  blockinfile: blockinfileModule,
  replace: replaceModule,
  stat: statModule,
  user: userModule,
  group: groupModule,
  authorized_key: authorizedKeyModule,
  command: (m) => commandModule(m, false),
  shell: (m) => commandModule(m, true),
  raw: rawModule,
  firewalld: firewalldModule,
  ufw: ufwModule,
  cron: cronModule,
  hostname: hostnameModule,
  timezone: timezoneModule,
  sysctl: sysctlModule,
  seboolean: seleniumBoolean,
  selinux: selinuxModule,
  wait_for: waitForModule,
  uri: uriModule,
  get_url: getUrlModule,
  git: gitModule,
  postgresql_db: pgDbModule,
  postgresql_user: pgUserModule,
  postgresql_privs: pgPrivsModule,
  mysql_db: myDbModule,
  mysql_user: myUserModule,
}

/** Colección de cada módulo (para resolver nombres completos y saber qué hay que instalar). */
export const MODULE_COLLECTION: Record<string, string> = {
  firewalld: 'ansible.posix',
  authorized_key: 'ansible.posix',
  sysctl: 'ansible.posix',
  seboolean: 'ansible.posix',
  selinux: 'ansible.posix',
  mount: 'ansible.posix',
  synchronize: 'ansible.posix',
  ufw: 'community.general',
  timezone: 'community.general',
  postgresql_db: 'community.postgresql',
  postgresql_user: 'community.postgresql',
  postgresql_privs: 'community.postgresql',
  mysql_db: 'community.mysql',
  mysql_user: 'community.mysql',
  win_ping: 'ansible.windows',
  win_feature: 'ansible.windows',
  win_service: 'ansible.windows',
  win_user: 'ansible.windows',
  win_group: 'ansible.windows',
  win_copy: 'ansible.windows',
  win_template: 'ansible.windows',
  win_file: 'ansible.windows',
  win_updates: 'ansible.windows',
  win_package: 'ansible.windows',
  win_shell: 'ansible.windows',
  win_command: 'ansible.windows',
  win_regedit: 'ansible.windows',
  win_reboot: 'ansible.windows',
  win_powershell: 'ansible.windows',
  win_optional_feature: 'ansible.windows',
  win_get_url: 'ansible.windows',
  win_stat: 'ansible.windows',
  win_firewall_rule: 'community.windows',
  win_domain_user: 'community.windows',
}

/** Módulos que corren en el nodo de control (no tocan el equipo). */
export const LOCAL_ACTIONS = new Set(['debug', 'set_fact', 'assert', 'fail', 'meta', 'pause', 'include_vars', 'include_tasks', 'import_tasks', 'include_role', 'import_role', 'setup', 'gather_facts', 'add_host', 'group_by', 'package_facts', 'service_facts', 'reboot', 'set_stats'])

/** Nombre corto y colección de una acción escrita como en el playbook. */
export function resolveAction(name: string): { short: string; collection: string } | undefined {
  const parts = name.split('.')
  const short = parts[parts.length - 1]
  const coll = parts.length === 3 ? `${parts[0]}.${parts[1]}` : undefined
  const known = short in REMOTE_MODULES || LOCAL_ACTIONS.has(short) || short in MODULE_COLLECTION
  if (!known) return undefined
  const home = MODULE_COLLECTION[short] ?? 'ansible.builtin'
  if (coll && coll !== home) {
    // ansible.legacy y algunos nombres que viven en más de una colección
    if (coll === 'ansible.legacy') return { short, collection: home }
    return undefined
  }
  return { short, collection: home }
}
