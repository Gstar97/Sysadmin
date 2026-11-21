/**
 * Respaldos con restic: repositorios cifrados con instantáneas deduplicadas, en una carpeta local,
 * en otro servidor por sftp, en un rest-server (que puede ser "solo agregar": acepta respaldos
 * nuevos pero no deja borrar) o en almacenamiento de objetos S3 (MinIO), con buckets que pueden
 * tener bloqueo de objetos (nadie los puede borrar hasta que vence el plazo).
 *
 * Los archivos se guardan de verdad: restore los devuelve con su contenido. Un repositorio en una
 * carpeta existe mientras exista su archivo "config": si un ransomware lo borra o lo cifra, el
 * repositorio se pierde, que es justamente lo que una copia inmutable evita.
 */
import { register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED, normalizePath, type Cred } from './vfs'
import { GiB, MiB } from './storage'
import type { BashState } from './schema'
import { hostByIp, inbound, routeTo, sourceIp } from './hosts'

// ---------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------

interface SnapFile {
  path: string
  type: 'file' | 'dir'
  data: string
  mode: number
  uid: number
  gid: number
  size: number
}

interface Snapshot {
  id: string
  time: number
  host: string
  user: string
  paths: string[]
  tags: string[]
  files: SnapFile[]
  parent?: string
}

interface Repo {
  id: string
  password: string
  snapshots: Snapshot[]
  /** Marca que se escribe en el archivo config (si cambia, alguien lo tocó). */
  marker: string
  /** Paquetes dañados (check los encuentra). */
  damaged: boolean
  /** Cuándo se creó cada objeto (para el bloqueo de objetos de S3). */
  created: number
}

/** Repositorios en carpetas: por equipo y ruta. */
const DIR_REPOS = new WeakMap<System, Map<string, Repo>>()

interface Bucket {
  name: string
  lockDays: number
  repos: Map<string, Repo>
}

interface ObjectStore {
  keys: { access: string; secret: string }[]
  buckets: Map<string, Bucket>
  port: number
}

const STORES = new WeakMap<System, ObjectStore>()

let seq = 0
function hex(n: number, seed = ''): string {
  let h = 2166136261 ^ ++seq
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  let out = ''
  while (out.length < n) {
    h = Math.imul(h ^ (out.length + 97), 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, n)
}

function dirRepos(sys: System): Map<string, Repo> {
  let m = DIR_REPOS.get(sys)
  if (!m) DIR_REPOS.set(sys, (m = new Map()))
  return m
}

function newRepo(password: string): Repo {
  return { id: hex(64), password, snapshots: [], marker: hex(32), damaged: false, created: Date.now() }
}

/** Crea los archivos que tiene un repositorio de restic en disco. */
function writeRepoFiles(sys: System, path: string, repo: Repo) {
  const v = sys.vfs
  v.mkdirp(path, ROOT_CRED)
  for (const d of ['data', 'index', 'keys', 'locks', 'snapshots']) v.mkdirp(`${path}/${d}`, ROOT_CRED)
  v.writeFile(`${path}/config`, `restic-config:${repo.marker}\n`, ROOT_CRED, { mode: 0o400 })
  v.writeFile(`${path}/keys/${hex(64, path)}`, '{"kdf":"scrypt"}\n', ROOT_CRED, { mode: 0o400 })
  syncSnapshotFiles(sys, path, repo)
}

function syncSnapshotFiles(sys: System, path: string, repo: Repo) {
  const v = sys.vfs
  const dir = `${path}/snapshots`
  if (!v.exists(dir, ROOT_CRED)) return
  for (const f of v.readdir(dir, ROOT_CRED)) if (!repo.snapshots.some((s) => s.id === f)) v.unlink(`${dir}/${f}`, ROOT_CRED)
  for (const s of repo.snapshots) if (!v.exists(`${dir}/${s.id}`, ROOT_CRED)) v.writeFile(`${dir}/${s.id}`, '(cifrado)\n', ROOT_CRED, { mode: 0o400 })
}

function bytesOf(s: Snapshot) {
  return s.files.reduce((n, f) => n + (f.type === 'file' ? f.size : 0), 0)
}

function human(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(3)} ${u[i]}`
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function stamp(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// ---------------------------------------------------------------------------------------
// Dónde está el repositorio
// ---------------------------------------------------------------------------------------

interface Location {
  kind: 'local' | 'sftp' | 'rest' | 's3'
  /** Lo que se muestra (como lo escribió el usuario). */
  label: string
  /** El equipo que guarda los datos. */
  host: System
  /** Carpeta del repositorio en ese equipo (local, sftp, rest). */
  path?: string
  bucket?: Bucket
  prefix?: string
  /** rest-server en modo solo agregar. */
  appendOnly?: boolean
}

interface RestServer {
  path: string
  port: number
  appendOnly: boolean
  noAuth: boolean
  privateRepos: boolean
}

/** Un rest-server corriendo en el equipo (como servicio o a mano): sus opciones. */
export function restServerOf(host: System): RestServer | undefined {
  if (host.poweredOff) return undefined
  const p = host.procs.find((x) => (x.cmd.split(/\s+/)[0].split('/').pop() ?? '') === 'rest-server')
  if (!p) return undefined
  const args = p.cmd.split(/\s+/).slice(1)
  const val = (n: string) => {
    const i = args.findIndex((a) => a === n || a.startsWith(n + '='))
    if (i < 0) return undefined
    return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]
  }
  const listen = val('--listen') ?? ':8000'
  return { path: val('--path') ?? '/tmp/restic', port: Number(listen.split(':').pop()) || 8000, appendOnly: args.includes('--append-only'), noAuth: args.includes('--no-auth'), privateRepos: args.includes('--private-repos') }
}

function env(ctx: CommandContext, name: string): string | undefined {
  return ctx.sh.vars.get(name)
}

function reach(ctx: CommandContext, name: string, port: number): System | string {
  const ip = ctx.sys.resolveHost(name) ?? name
  const host = hostByIp(ctx.sys, ip)
  if (!host || host.poweredOff || !routeTo(ctx.sys, ip)) return `dial tcp ${ip}:${port}: connect: no route to host`
  const fw = inbound(host, port, 'tcp', sourceIp(ctx.sys, ip))
  if (fw === 'drop') return `dial tcp ${ip}:${port}: i/o timeout`
  if (fw === 'reject') return `dial tcp ${ip}:${port}: connect: connection refused`
  return host
}

function locate(ctx: CommandContext, spec: string): Location | string {
  if (spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('local:')) {
    const path = normalizePath(ctx.sh.resolve(spec.replace(/^local:/, '')))
    return { kind: 'local', label: path, host: ctx.sys, path }
  }
  let m = /^sftp:(?:([^@]+)@)?([^:/]+):(.+)$/.exec(spec)
  if (m) {
    const host = reach(ctx, m[2], 22)
    if (typeof host === 'string') return `subprocess ssh: ssh: connect to host ${m[2]} port 22: ${host.includes('timeout') ? 'Connection timed out' : 'No route to host'}\nFatal: unable to open repository at ${spec}: unable to start the sftp session, error: EOF`
    if (!host.services.get('ssh')?.active && !host.services.get('sshd')?.active) return `subprocess ssh: ssh: connect to host ${m[2]} port 22: Connection refused\nFatal: unable to open repository at ${spec}: unable to start the sftp session, error: EOF`
    return { kind: 'sftp', label: spec, host, path: normalizePath(m[3]) }
  }
  m = /^rest:(https?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?\/?(.*?)\/?$/.exec(spec)
  if (m) {
    const port = Number(m[5] ?? (m[1] === 'https' ? 443 : 80))
    const host = reach(ctx, m[4], port)
    if (typeof host === 'string') return `Fatal: unable to open repository at ${spec}: Get "${m[1]}://${m[4]}:${port}/${m[6] ? m[6] + '/' : ''}config": ${host}`
    const rs = restServerOf(host)
    if (!rs || rs.port !== port) return `Fatal: unable to open repository at ${spec}: Get "${m[1]}://${m[4]}:${port}/${m[6] ? m[6] + '/' : ''}config": dial tcp ${host.ownIps()[0] ?? m[4]}:${port}: connect: connection refused`
    if (!rs.noAuth) {
      const ht = `${rs.path}/.htpasswd`
      const users = host.vfs.exists(ht, ROOT_CRED) ? host.vfs.readFile(ht, ROOT_CRED).split('\n').map((l) => l.split(':')[0]).filter(Boolean) : []
      if (!m[2] || !users.includes(m[2])) return `Fatal: unable to open config file: unexpected HTTP response (401): 401 Unauthorized\nIs there a repository at the following location?\nrepository: ${spec}`
      if (rs.privateRepos && m[6].split('/')[0] !== m[2]) return `Fatal: unable to open config file: unexpected HTTP response (401): 401 Unauthorized\nIs there a repository at the following location?\nrepository: ${spec}`
    }
    return { kind: 'rest', label: spec.replace(/:[^:@/]*@/, ':***@'), host, path: normalizePath(`${rs.path}/${m[6]}`), appendOnly: rs.appendOnly }
  }
  m = /^s3:(https?):\/\/([^:/]+)(?::(\d+))?\/([^/]+)\/?(.*)$/.exec(spec)
  if (m) {
    const port = Number(m[3] ?? (m[1] === 'https' ? 443 : 80))
    if (!env(ctx, 'AWS_ACCESS_KEY_ID') || !env(ctx, 'AWS_SECRET_ACCESS_KEY')) return `Fatal: unable to open repository at ${spec}: s3.getCredentials: no credentials found. Use \`-o s3.unsafe-anonymous-auth=true\` for anonymous authentication`
    const host = reach(ctx, m[2], port)
    if (typeof host === 'string') return `Fatal: unable to open repository at ${spec}: Head "${m[1]}://${m[2]}:${port}/${m[4]}/config": ${host}`
    const store = STORES.get(host)
    if (!store || store.port !== port || !host.services.get('minio')?.active) return `Fatal: unable to open repository at ${spec}: Head "${m[1]}://${m[2]}:${port}/${m[4]}/config": dial tcp: connect: connection refused`
    if (!store.keys.some((k) => k.access === env(ctx, 'AWS_ACCESS_KEY_ID') && k.secret === env(ctx, 'AWS_SECRET_ACCESS_KEY'))) return `Fatal: unable to open repository at ${spec}: client.BucketExists: The Access Key Id you provided does not exist in our records.`
    const bucket = store.buckets.get(m[4])
    if (!bucket) return `Fatal: unable to open repository at ${spec}: client.BucketExists: The specified bucket does not exist.`
    return { kind: 's3', label: spec, host, bucket, prefix: m[5].replace(/\/$/, '') }
  }
  return `Fatal: invalid backend: "${spec.split(':')[0]}"`
}

/** El repositorio que hay en ese lugar (si su config sigue intacto). */
function repoAt(loc: Location): Repo | undefined | 'damaged-config' {
  if (loc.kind === 's3') return loc.bucket!.repos.get(loc.prefix ?? '')
  const repo = dirRepos(loc.host).get(loc.path!)
  const cfg = `${loc.path}/config`
  if (!loc.host.vfs.exists(cfg, ROOT_CRED)) return undefined
  if (!repo) return undefined
  if (loc.host.vfs.readFile(cfg, ROOT_CRED) !== `restic-config:${repo.marker}\n`) return 'damaged-config'
  return repo
}

function storeRepo(loc: Location, repo: Repo) {
  if (loc.kind === 's3') loc.bucket!.repos.set(loc.prefix ?? '', repo)
  else {
    dirRepos(loc.host).set(loc.path!, repo)
    writeRepoFiles(loc.host, loc.path!, repo)
  }
}

/** Si el lugar no deja borrar: rest-server solo agregar, o bucket con bloqueo vigente. */
function deleteBlocked(loc: Location, repo: Repo, snap: Snapshot): string | undefined {
  if (loc.kind === 'rest' && loc.appendOnly) return `Remove(<snapshot/${snap.id.slice(0, 10)}>) returned error, retrying after 552.330144ms: blob not removed, server response: 403 Forbidden (403)\nFatal: unable to remove <snapshot/${snap.id.slice(0, 10)}> from the repository`
  if (loc.kind === 's3' && loc.bucket!.lockDays > 0 && Date.now() - Math.max(repo.created, snap.time) < loc.bucket!.lockDays * 86_400_000)
    return `Remove(<snapshot/${snap.id.slice(0, 10)}>) returned error, retrying after 720.551321ms: client.RemoveObject: Object, with version id: ${hex(8)}-${hex(4)}, is WORM protected and cannot be overwritten\nFatal: unable to remove <snapshot/${snap.id.slice(0, 10)}> from the repository`
  return undefined
}

// ---------------------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------------------

function capture(sys: System, cred: Cred, root: string, excludes: string[], errors: string[]): SnapFile[] {
  const v = sys.vfs
  const out: SnapFile[] = []
  const excluded = (p: string) => excludes.some((e) => p === e || p.startsWith(e.replace(/\/$/, '') + '/') || (e.startsWith('*') && p.endsWith(e.slice(1))))
  const walk = (path: string) => {
    if (excluded(path)) return
    let st
    try {
      st = v.stat(path, cred, false)
    } catch {
      errors.push(`error: lstat ${path}: no such file or directory`)
      return
    }
    if (st.type === 'dir') {
      out.push({ path, type: 'dir', data: '', mode: st.mode, uid: st.uid, gid: st.gid, size: 0 })
      let names: string[]
      try {
        names = v.readdir(path, cred)
      } catch {
        errors.push(`error: open ${path}: permission denied`)
        return
      }
      for (const n of names) walk(`${path === '/' ? '' : path}/${n}`)
    } else if (st.type === 'file') {
      try {
        const data = v.readFile(path, cred)
        out.push({ path, type: 'file', data, mode: st.mode, uid: st.uid, gid: st.gid, size: st.size ?? data.length })
      } catch {
        errors.push(`error: open ${path}: permission denied`)
      }
    }
  }
  walk(root)
  return out
}

/** Instantáneas como las arma un estado inicial: con los archivos que hay ahora. */
function initialSnapshot(sys: System, paths: string[], time: number, tags: string[], host?: string): Snapshot {
  const files = paths.flatMap((p) => capture(sys, ROOT_CRED, p, [], []))
  return { id: hex(64, paths.join() + time), time, host: host ?? sys.hostname, user: 'root', paths, tags, files }
}

// ---------------------------------------------------------------------------------------
// Política de retención (igual que restic forget)
// ---------------------------------------------------------------------------------------

export interface KeepPolicy {
  last?: number
  hourly?: number
  daily?: number
  weekly?: number
  monthly?: number
  yearly?: number
  withinDays?: number
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)
  return `${y}-${w}`
}

/** Qué instantáneas se quedan (por índice, ordenadas de la más nueva a la más vieja) y por qué. */
export function applyPolicy(times: number[], p: KeepPolicy, now = Date.now()): { keep: boolean; reasons: string[] }[] {
  const res = times.map(() => ({ keep: false, reasons: [] as string[] }))
  const rules: [keyof KeepPolicy, string, (d: Date) => string][] = [
    ['last', 'last snapshot', (d) => String(d.getTime()) + Math.random()],
    ['hourly', 'hourly snapshot', (d) => `${d.toDateString()} ${d.getHours()}`],
    ['daily', 'daily snapshot', (d) => d.toDateString()],
    ['weekly', 'weekly snapshot', isoWeek],
    ['monthly', 'monthly snapshot', (d) => `${d.getFullYear()}-${d.getMonth()}`],
    ['yearly', 'yearly snapshot', (d) => String(d.getFullYear())],
  ]
  for (const [k, label, key] of rules) {
    let left = p[k] ?? 0
    let lastKey: string | undefined
    for (let i = 0; i < times.length && left !== 0; i++) {
      const kk = key(new Date(times[i]))
      if (kk !== lastKey) {
        res[i].keep = true
        res[i].reasons.push(label)
        lastKey = kk
        if (left > 0) left--
      }
    }
  }
  if (p.withinDays) times.forEach((t, i) => {
    if (now - t <= p.withinDays! * 86_400_000) {
      res[i].keep = true
      res[i].reasons.push(`within ${p.withinDays}d`)
    }
  })
  return res
}

// ---------------------------------------------------------------------------------------
// restic
// ---------------------------------------------------------------------------------------

function table(rows: Snapshot[], withReasons?: string[][]): string {
  const head = `ID        Time                 Host        Tags        ${withReasons ? 'Reasons           ' : ''}Paths${withReasons ? '' : '        Size'}`
  const line = '-'.repeat(Math.max(head.length + 20, 80))
  let out = `${head}\n${line}\n`
  rows.forEach((s, i) => {
    const base = `${s.id.slice(0, 8)}  ${stamp(s.time)}  ${s.host.padEnd(10)}  ${s.tags.join(',').padEnd(10)}  `
    if (withReasons) out += `${base}${(withReasons[i][0] ?? '').padEnd(16)}  ${s.paths[0]}\n${withReasons[i].slice(1).map((r) => `${' '.repeat(base.length)}${r}\n`).join('')}${s.paths.slice(1).map((p) => `${' '.repeat(base.length + 18)}${p}\n`).join('')}`
    else out += `${base}${s.paths[0].padEnd(11)}  ${human(bytesOf(s))}\n${s.paths.slice(1).map((p) => `${' '.repeat(base.length)}${p}\n`).join('')}`
  })
  return `${out}${line}\n${rows.length} snapshots\n`
}

function findSnap(repo: Repo, ref: string, host?: string, path?: string): Snapshot | undefined {
  const list = repo.snapshots.filter((s) => (!host || s.host === host) && (!path || s.paths.includes(path))).sort((a, b) => b.time - a.time)
  if (ref === 'latest') return list[0]
  return repo.snapshots.find((s) => s.id.startsWith(ref))
}

register('restic', {
  usage: 'restic -r REPOSITORIO init|backup|snapshots|forget|prune|check|restore|ls|find|diff|stats|unlock',
  summary:
    '  init                      crea el repositorio\n  backup RUTA...            respalda (--tag, --exclude, --host)\n  snapshots                 lista las instantáneas\n  forget --keep-daily 7 ... aplica la retención (--prune borra los datos)\n  check [--read-data-subset 10%]  revisa el repositorio\n  restore ID|latest --target DIR [--include RUTA]\n  ls ID, find PATRÓN, diff ID1 ID2, stats, unlock\n  Repositorio: -r o RESTIC_REPOSITORY; clave: RESTIC_PASSWORD o --password-file',
  path: '/usr/bin',
  async run(ctx) {
    const a = [...ctx.args]
    const opt = (names: string[], flag = false): string | undefined => {
      for (const n of names) {
        const i = a.findIndex((x) => x === n || x.startsWith(n + '='))
        if (i < 0) continue
        if (a[i].includes('=')) {
          const v = a[i].split('=').slice(1).join('=')
          a.splice(i, 1)
          return v
        }
        if (flag) {
          a.splice(i, 1)
          return '1'
        }
        const v = a[i + 1]
        a.splice(i, 2)
        return v
      }
      return undefined
    }
    const optAll = (n: string): string[] => {
      const out: string[] = []
      for (let v = opt([n]); v !== undefined; v = opt([n])) out.push(v)
      return out
    }
    const repoSpec = opt(['-r', '--repo']) ?? (opt(['--repository-file']) ? undefined : env(ctx, 'RESTIC_REPOSITORY'))
    const pwFile = opt(['--password-file']) ?? env(ctx, 'RESTIC_PASSWORD_FILE')
    let password = env(ctx, 'RESTIC_PASSWORD')
    if (pwFile) {
      const p = ctx.sh.resolve(pwFile)
      try {
        password = ctx.sys.vfs.readFile(p, ctx.sh.cred).replace(/\n$/, '')
      } catch {
        ctx.err(`Fatal: Please specify password via RESTIC_PASSWORD or --password-file: open ${pwFile}: no such file or directory\n`)
        return 1
      }
    }
    const quiet = opt(['-q', '--quiet'], true) !== undefined
    opt(['--no-cache'], true)
    const verb = a.shift()
    if (!verb || verb === 'help' || verb === '--help') {
      ctx.out('restic is a backup program which allows saving multiple revisions of files and\ndirectories in an encrypted repository stored on different backends.\n\nUsage:\n  restic [command]\n\nAvailable Commands:\n  backup        Create a new backup of files and/or directories\n  check         Check the repository for errors\n  diff          Show differences between two snapshots\n  find          Find a file, a directory or restic IDs\n  forget        Remove snapshots from the repository\n  init          Initialize a new repository\n  ls            List files in a snapshot\n  prune         Remove unneeded data from the repository\n  restore       Extract the data from a snapshot\n  snapshots     List all snapshots\n  stats         Scan the repository and show basic statistics\n  unlock        Remove locks other processes created\n  version       Print version information\n')
      return 0
    }
    if (verb === 'version') {
      ctx.out(`restic ${ctx.sys.distro === 'rocky' ? '0.18.1' : '0.16.4'} compiled with go1.22.2 on linux/amd64\n`)
      return 0
    }
    if (!repoSpec) {
      ctx.err('Fatal: Please specify repository location (-r or --repository-file)\n')
      return 1
    }
    const loc = locate(ctx, repoSpec)
    if (typeof loc === 'string') {
      ctx.err(loc + '\n')
      return 1
    }
    if (!password) {
      ctx.err(verb === 'init' ? 'Fatal: an empty password is not allowed by default. Pass the flag `--insecure-no-password` to restic to disable this check\n' : 'Fatal: an empty password is not allowed by default. Pass the flag `--insecure-no-password` to restic to disable this check\n[simulador] Pasale la clave con RESTIC_PASSWORD o --password-file.\n')
      return 1
    }
    const existing = repoAt(loc)
    if (verb === 'init') {
      if (existing || (loc.kind !== 's3' && loc.host.vfs.exists(`${loc.path}/config`, ROOT_CRED))) {
        ctx.err(`Fatal: create repository at ${loc.label} failed: config file already exists\n`)
        return 1
      }
      if (loc.kind === 'local') {
        try {
          ctx.sys.vfs.mkdirp(loc.path!, ctx.sh.cred)
        } catch {
          ctx.err(`Fatal: create repository at ${loc.label} failed: mkdir ${loc.path}: permission denied\n`)
          return 1
        }
      }
      const repo = newRepo(password)
      storeRepo(loc, repo)
      ctx.out(`created restic repository ${repo.id.slice(0, 10)} at ${loc.label}\n\nPlease note that knowledge of your password is required to access\nthe repository. Losing your password means that your data is\nirrecoverably lost.\n`)
      return 0
    }
    if (existing === 'damaged-config') {
      ctx.err('Fatal: config cannot be loaded: ciphertext verification failed\n')
      return 1
    }
    if (!existing) {
      ctx.err(`Fatal: repository does not exist: unable to open config file: ${loc.kind === 's3' ? 'Stat: The specified key does not exist.' : `stat ${loc.path}/config: no such file or directory`}\nIs there a repository at the following location?\nrepository: ${loc.label}\n`)
      return 10
    }
    const repo = existing
    if (repo.password !== password) {
      ctx.err('Fatal: wrong password or no key found\n')
      return 12
    }
    const opened = `repository ${repo.id.slice(0, 8)} opened (version 2, compression level auto)\n`
    const save = () => {
      if (loc.kind !== 's3') syncSnapshotFiles(loc.host, loc.path!, repo)
    }
    const hostF = opt(['--host', '-H'])
    const tagF = opt(['--tag'])
    const pathF = opt(['--path'])
    const filtered = () => repo.snapshots.filter((s) => (!hostF || s.host === hostF) && (!tagF || tagF.split(',').every((t) => s.tags.includes(t))) && (!pathF || s.paths.includes(pathF))).sort((x, y) => x.time - y.time)

    switch (verb) {
      case 'snapshots': {
        const latest = opt(['--latest'])
        let list = filtered()
        if (latest) list = list.slice(-Number(latest))
        if (opt(['--json'], true)) {
          ctx.out(JSON.stringify(list.map((s) => ({ time: new Date(s.time).toISOString(), paths: s.paths, hostname: s.host, username: s.user, tags: s.tags.length ? s.tags : undefined, id: s.id, short_id: s.id.slice(0, 8) }))) + '\n')
          return 0
        }
        ctx.out(quiet ? table(list) : opened + table(list))
        return 0
      }
      case 'backup': {
        const tags = optAll('--tag').flatMap((t) => t.split(','))
        const excludes = optAll('--exclude').map((e) => (e.startsWith('*') ? e : normalizePath(ctx.sh.resolve(e))))
        const hostName = opt(['--host']) ?? ctx.sys.hostname
        const paths = a.filter((x) => !x.startsWith('-')).map((p) => normalizePath(ctx.sh.resolve(p)))
        if (!paths.length) {
          ctx.err('Fatal: nothing to backup, please specify source files/dirs\n')
          return 1
        }
        const errors: string[] = []
        const missing = paths.filter((p) => !ctx.sys.vfs.exists(p, ROOT_CRED))
        if (missing.length === paths.length) {
          ctx.err(`${opened}Fatal: all source directories/files do not exist\n`)
          return 1
        }
        for (const p of missing) errors.push(`error: lstat ${p}: no such file or directory`)
        const files = paths.flatMap((p) => capture(ctx.sys, ctx.sh.cred, p, excludes, errors))
        const parent = repo.snapshots.filter((s) => s.host === hostName && s.paths.join() === paths.join()).sort((x, y) => y.time - x.time)[0]
        const prev = new Map((parent?.files ?? []).map((f) => [f.path, f]))
        let fNew = 0
        let fChanged = 0
        let fSame = 0
        let dNew = 0
        let dSame = 0
        let added = 0
        for (const f of files) {
          const p = prev.get(f.path)
          if (f.type === 'dir') {
            if (p) dSame++
            else dNew++
            continue
          }
          if (!p) {
            fNew++
            added += f.size
          } else if (p.data !== f.data || p.size !== f.size) {
            fChanged++
            added += Math.min(f.size, Math.max(4096, Math.round(f.size * 0.1)))
          } else fSame++
        }
        if (loc.kind === 'rest' && loc.host.poweredOff) {
          ctx.err('Fatal: unable to save snapshot: connection refused\n')
          return 1
        }
        const snap: Snapshot = { id: hex(64, paths.join() + Date.now()), time: Date.now(), host: hostName, user: ctx.sh.user, paths, tags, files, parent: parent?.id }
        repo.snapshots.push(snap)
        save()
        const total = files.reduce((n, f) => n + f.size, 0)
        if (!quiet)
          ctx.out(
            `${opened}${parent ? `using parent snapshot ${parent.id.slice(0, 8)}\n` : 'no parent snapshot found, will read all files\n'}[0:00] 100.00%  ${repo.snapshots.length > 1 ? 1 : 0} / ${repo.snapshots.length > 1 ? 1 : 0} index files loaded\n\nFiles:        ${String(fNew).padStart(5)} new, ${String(fChanged).padStart(5)} changed, ${String(fSame).padStart(5)} unmodified\nDirs:         ${String(dNew).padStart(5)} new, ${String(0).padStart(5)} changed, ${String(dSame).padStart(5)} unmodified\nAdded to the repository: ${human(added)} (${human(Math.round(added * 0.62))} stored)\n\nprocessed ${fNew + fChanged + fSame} files, ${human(total)} in 0:0${Math.min(9, 1 + Math.floor(total / (200 * MiB)))}\n`,
          )
        for (const e of errors) ctx.err(e + '\n')
        ctx.out(`snapshot ${snap.id.slice(0, 8)} saved\n`)
        if (errors.length) {
          ctx.err('Warning: at least one source file could not be read\n')
          return 3
        }
        return 0
      }
      case 'forget': {
        const pol: KeepPolicy = {}
        const num = (k: string) => {
          const v = opt([k])
          return v === undefined ? undefined : Number(v)
        }
        pol.last = num('--keep-last')
        pol.hourly = num('--keep-hourly')
        pol.daily = num('--keep-daily')
        pol.weekly = num('--keep-weekly')
        pol.monthly = num('--keep-monthly')
        pol.yearly = num('--keep-yearly')
        const within = opt(['--keep-within'])
        if (within) pol.withinDays = Number(/(\d+)d/.exec(within)?.[1] ?? 0) + Number(/(\d+)m/.exec(within)?.[1] ?? 0) * 30 + Number(/(\d+)y/.exec(within)?.[1] ?? 0) * 365
        const prune = opt(['--prune'], true) !== undefined
        const dry = opt(['--dry-run', '-n'], true) !== undefined
        opt(['--group-by'])
        const ids = a.filter((x) => !x.startsWith('-'))
        let out = opened
        let toRemove: Snapshot[] = []
        if (ids.length) {
          for (const id of ids) {
            const s = findSnap(repo, id)
            if (!s) {
              ctx.err(`Ignoring "${id}": no matching ID found for prefix "${id}"\n`)
              continue
            }
            toRemove.push(s)
          }
        } else {
          if (!Object.values(pol).some((v) => v !== undefined && v !== 0)) {
            ctx.err('no policy was specified, no snapshots will be removed\n')
            return 0
          }
          const groups = new Map<string, Snapshot[]>()
          for (const s of filtered()) groups.set(`${s.host}|${s.paths.join(',')}`, [...(groups.get(`${s.host}|${s.paths.join(',')}`) ?? []), s])
          const desc = [pol.last && `${pol.last} latest`, pol.hourly && `${pol.hourly} hourly`, pol.daily && `${pol.daily} daily`, pol.weekly && `${pol.weekly} weekly`, pol.monthly && `${pol.monthly} monthly`, pol.yearly && `${pol.yearly} yearly`].filter(Boolean).join(', ')
          out += `Applying Policy: keep ${desc} snapshots${pol.withinDays ? `, keep all snapshots within ${within}` : ''}\n`
          for (const [g, list] of groups) {
            const sorted = [...list].sort((x, y) => y.time - x.time)
            const r = applyPolicy(sorted.map((s) => s.time), pol)
            const keep = sorted.filter((_s, i) => r[i].keep)
            const rem = sorted.filter((_s, i) => !r[i].keep)
            const [host, paths] = g.split('|')
            out += `snapshots for (host [${host}], paths [${paths}]):\nkeep ${keep.length} snapshots:\n${table(keep, sorted.map((_s, i) => r[i].reasons).filter((_x, i) => r[i].keep)).replace(/\n\d+ snapshots\n$/, '\n')}\n`
            if (rem.length) out += `remove ${rem.length} snapshots:\n${table(rem).replace(/\n\d+ snapshots\n$/, '\n')}\n`
            toRemove.push(...rem)
          }
        }
        ctx.out(out)
        if (dry) {
          ctx.out(`Would have removed the following snapshots:\n{${toRemove.map((s) => s.id.slice(0, 8)).join(' ')}}\n\n`)
          return 0
        }
        for (const s of toRemove) {
          const blocked = deleteBlocked(loc, repo, s)
          if (blocked) {
            ctx.err(blocked + '\n')
            return 1
          }
        }
        if (toRemove.length) {
          repo.snapshots = repo.snapshots.filter((s) => !toRemove.includes(s))
          save()
          ctx.out(`[0:00] 100.00%  ${toRemove.length} / ${toRemove.length} files deleted\n`)
        }
        if (prune && toRemove.length) ctx.out(`${pruneText(repo, toRemove)}`)
        toRemove = []
        return 0
      }
      case 'prune': {
        if (loc.kind === 'rest' && loc.appendOnly) {
          ctx.err(`${opened}loading indexes...\nloading all snapshots...\nfinding data that is still in use for ${repo.snapshots.length} snapshots\n...\ndeleting unreferenced packs\nRemove(<data/${hex(10)}>) returned error, retrying after 552.330144ms: blob not removed, server response: 403 Forbidden (403)\nFatal: unable to remove <data/${hex(10)}> from the repository\n`)
          return 1
        }
        ctx.out(opened + pruneText(repo, []))
        return 0
      }
      case 'check': {
        const subset = opt(['--read-data-subset'])
        const all = opt(['--read-data'], true) !== undefined
        let out = `using temporary cache in /tmp/restic-check-cache-${hex(9)}\n${opened}create exclusive lock for repository\nload indexes\n[0:00] 100.00%  ${Math.max(1, repo.snapshots.length)} / ${Math.max(1, repo.snapshots.length)} index files loaded\ncheck all packs\ncheck snapshots, trees and blobs\n[0:00] 100.00%  ${repo.snapshots.length} / ${repo.snapshots.length} snapshots\n`
        if (subset || all) out += `read ${all ? 'all' : subset} data packs\n[0:0${all ? 4 : 1}] 100.00%  ${all ? 214 : Math.max(1, Math.round(214 * (parseFloat(subset!) || 10) / 100))} / ${all ? 214 : Math.max(1, Math.round(214 * (parseFloat(subset!) || 10) / 100))} packs\n`
        if (repo.damaged && (subset || all)) {
          ctx.out(out)
          ctx.err(`Pack ID does not match, want ${hex(8)}, got ${hex(8)}\n[0:01] 100.00%  ...\nFatal: repository contains errors\n`)
          return 1
        }
        ctx.out(out + 'no errors were found\n')
        if (repo.damaged && !(subset || all)) ctx.err('[simulador] Sin leer los datos (--read-data-subset), check solo revisa la estructura: no ve los paquetes dañados.\n')
        return 0
      }
      case 'restore': {
        const target = opt(['--target', '-t'])
        const includes = optAll('--include').map((p) => normalizePath(p))
        const ref = a.find((x) => !x.startsWith('-'))
        if (!ref) {
          ctx.err('Fatal: no snapshot ID specified\n')
          return 1
        }
        if (!target) {
          ctx.err('Fatal: Please specify a directory to restore to (--target)\n')
          return 1
        }
        const snap = findSnap(repo, ref.split(':')[0], hostF, pathF)
        if (!snap) {
          ctx.err(`Fatal: failed to find snapshot: no matching ID found for prefix "${ref}"\n`)
          return 1
        }
        const root = normalizePath(ctx.sh.resolve(target))
        const sel = snap.files.filter((f) => !includes.length || includes.some((i) => f.path === i || f.path.startsWith(i + '/') || i.startsWith(f.path + '/')))
        let n = 0
        let bytes = 0
        try {
          for (const f of sel) {
            const dest = normalizePath(`${root}/${f.path}`)
            if (f.type === 'dir') ctx.sys.vfs.mkdirp(dest, ctx.sh.cred)
            else {
              ctx.sys.vfs.mkdirp(dest.slice(0, dest.lastIndexOf('/')) || '/', ctx.sh.cred)
              ctx.sys.vfs.writeFile(dest, f.data, ctx.sh.cred, { mode: f.mode & 0o7777 })
              const node = ctx.sys.vfs.stat(dest, ROOT_CRED)
              node.size = f.size
              if (ctx.sh.user === 'root') {
                node.uid = f.uid
                node.gid = f.gid
              }
              bytes += f.size
            }
            n++
          }
        } catch (e) {
          ctx.err(`ignoring error for ${root}: ${(e as Error).message}\nFatal: There were 1 errors\n`)
          return 1
        }
        ctx.out(`${opened}[0:00] 100.00%  ${n} files/dirs ${human(bytes)}, total ${n} files/dirs ${human(bytes)}\nrestoring snapshot ${snap.id.slice(0, 8)} of [${snap.paths.join(' ')}] at ${new Date(snap.time).toISOString().replace('T', ' ').replace(/\..*/, '')} by ${snap.user}@${snap.host} to ${root}\nSummary: Restored ${n} files/dirs (${human(bytes)}) in 0:0${Math.min(9, 1 + Math.floor(bytes / (300 * MiB)))}\n`)
        return 0
      }
      case 'ls': {
        const ref = a.find((x) => !x.startsWith('-'))
        const sub = a.filter((x) => !x.startsWith('-'))[1]
        const snap = ref ? findSnap(repo, ref, hostF, pathF) : undefined
        if (!snap) {
          ctx.err(`Fatal: failed to find snapshot: no matching ID found for prefix "${ref ?? ''}"\n`)
          return 1
        }
        const long = opt(['-l', '--long'], true) !== undefined
        ctx.out(`snapshot ${snap.id.slice(0, 8)} of [${snap.paths.join(' ')}] at ${new Date(snap.time).toISOString()} by ${snap.user}@${snap.host} filtered by []:\n`)
        for (const f of snap.files.filter((x) => !sub || x.path === sub || x.path.startsWith(sub.replace(/\/$/, '') + '/'))) ctx.out(long ? `${f.type === 'dir' ? 'd' : '-'}${(f.mode & 0o777).toString(8)} ${f.uid} ${f.gid} ${String(f.size).padStart(10)} ${stamp(snap.time)} ${f.path}\n` : `${f.path}\n`)
        return 0
      }
      case 'find': {
        const pat = a.find((x) => !x.startsWith('-')) ?? ''
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
        let out = opened
        for (const s of filtered()) {
          const hits = s.files.filter((f) => re.test(f.path.split('/').pop() ?? '') || re.test(f.path))
          if (!hits.length) continue
          out += `Found matching entries in snapshot ${s.id.slice(0, 8)} from ${stamp(s.time)}\n${hits.map((f) => `${f.path}\n`).join('')}\n`
        }
        ctx.out(out)
        return 0
      }
      case 'diff': {
        const [x, y] = a.filter((v) => !v.startsWith('-')).map((r) => findSnap(repo, r))
        if (!x || !y) {
          ctx.err('Fatal: failed to find snapshot\n')
          return 1
        }
        const mx = new Map(x.files.map((f) => [f.path, f]))
        const my = new Map(y.files.map((f) => [f.path, f]))
        let out = `${opened}comparing snapshot ${x.id.slice(0, 8)} to ${y.id.slice(0, 8)}:\n\n`
        let add = 0
        let rem = 0
        let mod = 0
        for (const f of y.files) {
          const o = mx.get(f.path)
          if (!o) {
            out += `+    ${f.path}${f.type === 'dir' ? '/' : ''}\n`
            add++
          } else if (f.type === 'file' && (o.data !== f.data || o.size !== f.size)) {
            out += `M    ${f.path}\n`
            mod++
          }
        }
        for (const f of x.files)
          if (!my.has(f.path)) {
            out += `-    ${f.path}${f.type === 'dir' ? '/' : ''}\n`
            rem++
          }
        ctx.out(`${out}\nFiles:        ${add} new, ${rem} removed, ${mod} changed\n`)
        return 0
      }
      case 'stats': {
        const mode = opt(['--mode']) ?? 'restore-size'
        const total = repo.snapshots.reduce((n, s) => n + bytesOf(s), 0)
        const uniq = new Map<string, number>()
        for (const s of repo.snapshots) for (const f of s.files) if (f.type === 'file') uniq.set(f.path + f.data + f.size, f.size)
        const raw = [...uniq.values()].reduce((n, b) => n + b, 0)
        ctx.out(
          mode === 'raw-data'
            ? `${opened}scanning...\nStats in raw-data mode:\n     Snapshots processed:  ${repo.snapshots.length}\n        Total Blob Count:  ${uniq.size * 3}\n     Total Uncompressed Size:  ${human(raw)}\n              Total Size:  ${human(Math.round(raw * 0.62))}\n    Compression Progress:  100.00%\n       Compression Ratio:  1.61x\nCompression Space Saving:  38.00%\n`
            : `${opened}scanning...\nStats in restore-size mode:\n     Snapshots processed:  ${repo.snapshots.length}\n        Total File Count:  ${repo.snapshots.reduce((n, s) => n + s.files.length, 0)}\n              Total Size:  ${human(total)}\n`,
        )
        return 0
      }
      case 'unlock':
        ctx.out(opened + 'successfully removed 0 locks\n')
        return 0
      default:
        ctx.err(`Error: unknown command "${verb}" for "restic"\nRun 'restic --help' for usage.\n`)
        return 1
    }
  },
})

function pruneText(repo: Repo, removed: Snapshot[]): string {
  const freed = removed.reduce((n, s) => n + Math.round(bytesOf(s) * 0.04), 0) + 3 * MiB
  const keep = repo.snapshots.reduce((n, s) => n + bytesOf(s), 0)
  return `loading indexes...\nloading all snapshots...\nfinding data that is still in use for ${repo.snapshots.length} snapshots\n[0:00] 100.00%  ${repo.snapshots.length} / ${repo.snapshots.length} snapshots\nsearching used packs...\ncollecting packs for deletion and repacking\n[0:00] 100.00%  37 / 37 packs processed\n\nto repack:            12 blobs / 1.044 MiB\nthis removes:          9 blobs / ${human(freed)}\nto delete:             4 blobs / ${human(Math.round(freed * 0.3))}\ntotal prune:          13 blobs / ${human(Math.round(freed * 1.3))}\nremaining:           ${repo.snapshots.length * 40} blobs / ${human(Math.round(keep * 0.62))}\nunused size after prune: 0 B (0.00% of remaining size)\n\nrepacking packs\n[0:00] 100.00%  2 / 2 packs repacked\nrebuilding index\n[0:00] 100.00%  33 / 33 packs processed\ndeleting obsolete index files\nremoving 6 old packs\n[0:00] 100.00%  6 / 6 files deleted\ndone\n`
}

// ---------------------------------------------------------------------------------------
// rest-server
// ---------------------------------------------------------------------------------------

register('rest-server', {
  usage: 'rest-server --path CARPETA [--listen :8000] [--append-only] [--private-repos] [--no-auth]',
  path: '/usr/bin',
  run(ctx) {
    const p = ctx.args.includes('--path') ? ctx.args[ctx.args.indexOf('--path') + 1] : '/tmp/restic'
    const listen = ctx.args.includes('--listen') ? ctx.args[ctx.args.indexOf('--listen') + 1] : ':8000'
    if (ctx.args.includes('--version')) {
      ctx.out('rest-server 0.13.0 compiled with go1.22.5 on linux/amd64\n')
      return 0
    }
    ctx.out(`Data directory: ${p}\n${ctx.args.includes('--no-auth') ? 'Authentication disabled' : 'Authentication enabled'}\n${ctx.args.includes('--append-only') ? 'Append only mode enabled' : ''}${ctx.args.includes('--private-repos') ? '\nPrivate repositories enabled' : '\nPrivate repositories disabled'}\nStarting server on ${listen}\n`)
    ctx.err('[simulador] En la terminal, el servidor no queda corriendo: usalo como servicio (systemctl start rest-server).\n')
    return 0
  },
})

const REST_UNIT = `[Unit]
Description=Rest Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rest-server
Group=rest-server
ExecStart=/usr/bin/rest-server --path /srv/restic --listen :8000
Restart=always

[Install]
WantedBy=multi-user.target
`

System.installHooks['rest-server'] = (sys) => {
  sys.vfs.mkdirp('/srv/restic', ROOT_CRED)
  const uid = sys.users.get('rest-server')?.uid
  if (uid !== undefined) {
    const n = sys.vfs.stat('/srv/restic', ROOT_CRED)
    n.uid = uid
    n.gid = sys.users.get('rest-server')!.gid
  }
  if (!sys.vfs.exists('/etc/systemd/system/rest-server.service', ROOT_CRED)) sys.vfs.writeFile('/etc/systemd/system/rest-server.service', REST_UNIT, ROOT_CRED, { mode: 0o644 })
}

// ---------------------------------------------------------------------------------------
// Estado inicial
// ---------------------------------------------------------------------------------------

System.initHooks.push((sys, state: BashState) => {
  const o = state.objetos
  if (o) {
    const store: ObjectStore = { keys: o.claves.map((k) => ({ access: k.acceso, secret: k.secreto })), buckets: new Map(), port: o.puerto }
    for (const b of o.buckets) store.buckets.set(b.nombre, { name: b.nombre, lockDays: b.bloqueo_dias, repos: new Map() })
    STORES.set(sys, store)
    sys.services.set('minio', { name: 'minio', description: 'MinIO', active: true, enabled: true, failed: false, ports: [o.puerto, o.puerto + 1], since: Date.now() - 86_400_000 * 40 })
    sys.spawn('minio-user', `/usr/local/bin/minio server /mnt/data --console-address :${o.puerto + 1}`, 0, 1.2, 3, Date.now() - 86_400_000 * 40, 'minio')
  }
  const r = state.restic
  if (!r) return
  for (const spec of r.repos) {
    const repo = newRepo(spec.clave)
    repo.created = Date.now() - 86_400_000 * Math.max(0, ...spec.instantaneas.map((s) => s.dias_atras))
    for (const s of spec.instantaneas) repo.snapshots.push(initialSnapshot(sys, s.rutas, Date.now() - s.dias_atras * 86_400_000, s.etiquetas, s.equipo))
    repo.damaged = spec.dañado
    if (spec.bucket) {
      const b = STORES.get(sys)?.buckets.get(spec.bucket)
      if (b) b.repos.set(spec.prefijo ?? '', repo)
    } else if (spec.ruta) {
      dirRepos(sys).set(spec.ruta, repo)
      writeRepoFiles(sys, spec.ruta, repo)
    }
  }
})

// Los archivos de las instantáneas del estado inicial se toman de otro equipo (el que respalda).
System.labHooks.push((all, states) => {
  states.forEach((st, i) => {
    for (const spec of st.restic?.repos ?? []) {
      if (!spec.origen) continue
      const src = all.find((s) => s.hostname === spec.origen)
      const repo = spec.bucket ? STORES.get(all[i])?.buckets.get(spec.bucket)?.repos.get(spec.prefijo ?? '') : dirRepos(all[i]).get(spec.ruta ?? '')
      if (!src || !repo) continue
      repo.snapshots.forEach((s, k) => {
        repo.snapshots[k] = { ...initialSnapshot(src, s.paths, s.time, s.tags, spec.instantaneas[k]?.equipo ?? src.hostname), id: s.id }
      })
      if (spec.ruta) syncSnapshotFiles(all[i], spec.ruta, repo)
    }
  })
})

// ---------------------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------------------

function repoForCheck(sys: System, where: string): { repo?: Repo; loc?: Location } {
  if (where.startsWith('/')) {
    const loc: Location = { kind: 'local', label: where, host: sys, path: normalizePath(where) }
    const r = repoAt(loc)
    return { repo: typeof r === 'object' ? r : undefined, loc }
  }
  const m = /^s3:([^/]+)\/?(.*)$/.exec(where)
  if (m) return { repo: STORES.get(sys)?.buckets.get(m[1])?.repos.get(m[2]) }
  return {}
}

export function verifyBackup(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('restic_repo' in check) {
    const c = check as { restic_repo: string; instantaneas_min?: number; con_ruta?: string; con_archivo?: string; etiqueta?: string; existe?: boolean; clave?: string }
    const { repo } = repoForCheck(sys, c.restic_repo)
    if (c.existe === false) return { ok: !repo, label: `no hay un repositorio de restic en ${c.restic_repo}` }
    let ok = !!repo
    const parts: string[] = []
    const snaps = (repo?.snapshots ?? []).filter((s) => (!c.con_ruta || s.paths.includes(c.con_ruta)) && (!c.etiqueta || s.tags.includes(c.etiqueta)))
    if (c.con_ruta) parts.push(`de ${c.con_ruta}`)
    if (c.etiqueta) parts.push(`con la etiqueta ${c.etiqueta}`)
    if (ok && c.instantaneas_min !== undefined) {
      ok = snaps.length >= c.instantaneas_min
      parts.push(`con al menos ${c.instantaneas_min} instantánea(s)`)
    } else if (ok && (c.con_ruta || c.etiqueta)) ok = snaps.length > 0
    if (ok && c.con_archivo) {
      ok = snaps.some((s) => s.files.some((f) => f.path === c.con_archivo))
      parts.push(`que incluyen ${c.con_archivo}`)
    }
    if (ok && c.clave) ok = repo!.password === c.clave
    return { ok, label: `hay un repositorio de restic en ${c.restic_repo}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('rest_server' in check) {
    const c = check as { rest_server: boolean; solo_agregar?: boolean; carpeta?: string; con_clave?: boolean }
    const rs = restServerOf(sys)
    let ok = !!rs === c.rest_server
    if (ok && rs && c.solo_agregar !== undefined) ok = rs.appendOnly === c.solo_agregar
    if (ok && rs && c.carpeta) ok = rs.path === c.carpeta
    if (ok && rs && c.con_clave) ok = !rs.noAuth && sys.vfs.exists(`${rs.path}/.htpasswd`, ROOT_CRED)
    return { ok, label: c.rest_server ? `rest-server está corriendo${c.solo_agregar ? ' en modo solo agregar (--append-only)' : ''}${c.con_clave ? ' con usuarios y claves' : ''}` : 'rest-server no está corriendo' }
  }
  return undefined
}

void GiB
