/**
 * Git: repositorios con historial de verdad. Cada commit guarda la foto completa de los archivos
 * versionados; status, diff, log, ramas, fusiones de tres vías (con conflictos marcados en los
 * archivos), restore, reset, revert, stash, etiquetas, .gitignore, hooks que se ejecutan con el
 * shell del simulador, y repositorios remotos en otros equipos (por ruta o por ssh), con clone,
 * fetch, pull y push (y su rechazo cuando el remoto tiene commits que no tenés).
 *
 * También git filter-repo (para sacar un archivo o un texto de todo el historial) y gitleaks
 * (para buscar secretos), que se usan en el caso de la contraseña subida.
 */
import { COMMANDS, register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED, normalizePath } from './vfs'
import { hostByIp, inbound, routeTo, sourceIp } from './hosts'
import { parse } from './parser'
import type { BashState } from './schema'

// ---------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------

interface Entry {
  data: string
  mode: number
}

type Snapshot = Map<string, Entry>

interface Commit {
  id: string
  tree: Snapshot
  parents: string[]
  author: string
  email: string
  time: number
  message: string
}

interface Repo {
  bare: boolean
  commits: Map<string, Commit>
  /** refs/heads/x, refs/tags/x, refs/remotes/origin/x */
  refs: Map<string, string>
  /** Rama actual (refs/heads/x) o un commit suelto. */
  head: string
  detached: boolean
  index: Snapshot
  remotes: Map<string, string>
  upstream: Map<string, string>
  config: Map<string, string>
  merging?: { other: string; label: string }
  stash: { work: Snapshot; index: Snapshot; base: string; msg: string }[]
  tagMessages: Map<string, string>
}

const REPOS = new WeakMap<System, Map<string, Repo>>()

function repos(sys: System) {
  let m = REPOS.get(sys)
  if (!m) REPOS.set(sys, (m = new Map()))
  return m
}

let seq = 0
function sha(seed: string): string {
  let h1 = 0x811c9dc5 ^ ++seq
  let h2 = 0x01000193
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0
  }
  let out = ''
  for (let i = 0; out.length < 40; i++) {
    h1 = Math.imul(h1 ^ (h2 >>> 7) ^ i, 16777619) >>> 0
    h2 = Math.imul(h2 ^ (h1 >>> 3), 2246822519) >>> 0
    out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

function newRepo(bare: boolean, branch: string): Repo {
  return { bare, commits: new Map(), refs: new Map(), head: `refs/heads/${branch}`, detached: false, index: new Map(), remotes: new Map(), upstream: new Map(), config: new Map(), stash: [], tagMessages: new Map() }
}

function gitDir(root: string, bare: boolean) {
  return bare ? root : `${root === '/' ? '' : root}/.git`
}

function writeGitDir(sys: System, root: string, repo: Repo) {
  const g = gitDir(root, repo.bare)
  const v = sys.vfs
  for (const d of ['', '/objects', '/refs/heads', '/refs/tags', '/hooks', '/info']) v.mkdirp(g + d, ROOT_CRED)
  v.writeFile(`${g}/HEAD`, repo.detached ? `${repo.head}\n` : `ref: ${repo.head}\n`, ROOT_CRED)
  if (!v.exists(`${g}/config`, ROOT_CRED)) v.writeFile(`${g}/config`, `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${repo.bare}\n${repo.bare ? '' : '\tlogallrefupdates = true\n'}`, ROOT_CRED)
  if (!v.exists(`${g}/description`, ROOT_CRED)) v.writeFile(`${g}/description`, "Unnamed repository; edit this file 'description' to name the repository.\n", ROOT_CRED)
  if (!v.exists(`${g}/info/exclude`, ROOT_CRED)) v.writeFile(`${g}/info/exclude`, '# git ls-files --others --exclude-from=.git/info/exclude\n', ROOT_CRED)
  for (const s of ['pre-commit', 'commit-msg', 'pre-push']) if (!v.exists(`${g}/hooks/${s}.sample`, ROOT_CRED)) v.writeFile(`${g}/hooks/${s}.sample`, `#!/bin/sh\n# Ejemplo de hook ${s}. Para activarlo, sacale el .sample.\n`, ROOT_CRED, { mode: 0o755 })
  syncRefFiles(sys, root, repo)
}

function syncRefFiles(sys: System, root: string, repo: Repo) {
  const g = gitDir(root, repo.bare)
  const v = sys.vfs
  if (!v.exists(g, ROOT_CRED)) return
  v.writeFile(`${g}/HEAD`, repo.detached ? `${repo.head}\n` : `ref: ${repo.head}\n`, ROOT_CRED)
  for (const kind of ['heads', 'tags']) {
    const dir = `${g}/refs/${kind}`
    v.mkdirp(dir, ROOT_CRED)
    for (const f of v.readdir(dir, ROOT_CRED)) if (!repo.refs.has(`refs/${kind}/${f}`)) v.removeTree(`${dir}/${f}`, ROOT_CRED)
  }
  for (const [r, id] of repo.refs) {
    if (r.startsWith('refs/remotes/')) continue
    const p = `${g}/${r}`
    v.mkdirp(p.slice(0, p.lastIndexOf('/')), ROOT_CRED)
    v.writeFile(p, `${id}\n`, ROOT_CRED)
  }
  // Todo .git es del dueño de la carpeta del repositorio.
  const owner = v.stat(root, ROOT_CRED)
  if (owner.uid !== 0) {
    const fix = (p: string) => {
      const st = v.stat(p, ROOT_CRED, false)
      st.uid = owner.uid
      st.gid = owner.gid
      if (st.type === 'dir') for (const n of v.readdir(p, ROOT_CRED)) fix(`${p}/${n}`)
    }
    fix(g)
  }
}

/** El repositorio que contiene a una carpeta (subiendo hasta encontrar .git). */
function findRepo(sys: System, dir: string): { root: string; repo: Repo } | undefined {
  let d = normalizePath(dir)
  for (;;) {
    const r = repos(sys).get(d)
    if (r && sys.vfs.exists(`${gitDir(d, r.bare)}/HEAD`, ROOT_CRED)) return { root: d, repo: r }
    if (d === '/') return undefined
    d = d.slice(0, d.lastIndexOf('/')) || '/'
  }
}

// ---------------------------------------------------------------------------------------
// Árbol de trabajo
// ---------------------------------------------------------------------------------------

function globRe(p: string): RegExp {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i++
        if (p[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`^${re}$`)
}

function ignoreRules(sys: System, root: string): { re: RegExp; neg: boolean; dirOnly: boolean; anchored: boolean }[] {
  const rules: { re: RegExp; neg: boolean; dirOnly: boolean; anchored: boolean }[] = []
  const add = (text: string) => {
    for (let line of text.split('\n')) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      const neg = line.startsWith('!')
      if (neg) line = line.slice(1)
      const dirOnly = line.endsWith('/')
      if (dirOnly) line = line.slice(0, -1)
      const anchored = line.startsWith('/') || line.includes('/')
      line = line.replace(/^\//, '')
      rules.push({ re: globRe(line), neg, dirOnly, anchored })
    }
  }
  for (const f of [`${root}/.gitignore`, `${root}/.git/info/exclude`]) if (sys.vfs.exists(f, ROOT_CRED)) add(sys.vfs.readFile(f, ROOT_CRED))
  return rules
}

function isIgnored(rules: ReturnType<typeof ignoreRules>, rel: string, isDir: boolean): boolean {
  let ign = false
  const parts = rel.split('/')
  for (const r of rules) {
    // Coincide con la ruta entera, o con alguna carpeta que la contiene.
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/')
      const subIsDir = i < parts.length || isDir
      if (r.dirOnly && !subIsDir) continue
      const hit = r.anchored ? r.re.test(sub) : r.re.test(parts[i - 1])
      if (hit) {
        ign = !r.neg
        break
      }
    }
  }
  return ign
}

/** Los archivos del árbol de trabajo (sin .git), relativos a la raíz. */
function workFiles(sys: System, root: string): Snapshot {
  const out: Snapshot = new Map()
  const v = sys.vfs
  const walk = (dir: string, rel: string) => {
    let names: string[]
    try {
      names = v.readdir(dir, ROOT_CRED)
    } catch {
      return
    }
    for (const n of names) {
      if (!rel && n === '.git') continue
      const p = `${dir === '/' ? '' : dir}/${n}`
      const r = rel ? `${rel}/${n}` : n
      const st = v.stat(p, ROOT_CRED, false)
      if (st.type === 'dir') walk(p, r)
      else if (st.type === 'file') out.set(r, { data: st.data, mode: st.mode & 0o111 ? 0o755 : 0o644 })
    }
  }
  walk(root, '')
  return out
}

function untrackedOf(sys: System, root: string, repo: Repo, work: Snapshot): string[] {
  const rules = ignoreRules(sys, root)
  return [...work.keys()].filter((p) => !repo.index.has(p) && !isIgnored(rules, p, false)).sort()
}

function headCommit(repo: Repo): Commit | undefined {
  const id = repo.detached ? repo.head : repo.refs.get(repo.head)
  return id ? repo.commits.get(id) : undefined
}

function branchName(repo: Repo) {
  return repo.head.replace('refs/heads/', '')
}

/** Crea carpetas y escribe un archivo con el dueño de la carpeta del repositorio (como el usuario que corre git). */
function putFile(sys: System, root: string, rel: string, e: Entry) {
  const v = sys.vfs
  const owner = v.exists(root, ROOT_CRED) ? v.stat(root, ROOT_CRED) : undefined
  const parts = rel.split('/')
  let d = root
  for (const p of parts.slice(0, -1)) {
    d = `${d}/${p}`
    if (!v.exists(d, ROOT_CRED)) {
      v.mkdirp(d, ROOT_CRED)
      if (owner) {
        const st = v.stat(d, ROOT_CRED)
        st.uid = owner.uid
        st.gid = owner.gid
      }
    }
  }
  const abs = `${root}/${rel}`
  const isNew = !v.exists(abs, ROOT_CRED)
  v.writeFile(abs, e.data, ROOT_CRED, { mode: e.mode })
  v.chmod(abs, e.mode, ROOT_CRED)
  if (isNew && owner) {
    const st = v.stat(abs, ROOT_CRED)
    st.uid = owner.uid
    st.gid = owner.gid
  }
}

function writeTree(sys: System, root: string, from: Snapshot, to: Snapshot) {
  const v = sys.vfs
  for (const p of from.keys()) {
    if (to.has(p)) continue
    const abs = `${root}/${p}`
    if (v.exists(abs, ROOT_CRED)) v.unlink(abs, ROOT_CRED)
    // Borrar carpetas que quedaron vacías.
    let d = abs.slice(0, abs.lastIndexOf('/'))
    while (d.length > root.length && v.exists(d, ROOT_CRED) && !v.readdir(d, ROOT_CRED).length) {
      v.rmdir(d, ROOT_CRED)
      d = d.slice(0, d.lastIndexOf('/'))
    }
  }
  for (const [p, e] of to) if (!sameEntry(from.get(p), e) || !v.exists(`${root}/${p}`, ROOT_CRED)) putFile(sys, root, p, e)
}

function sameEntry(a?: Entry, b?: Entry) {
  return !!a && !!b && a.data === b.data && a.mode === b.mode
}

// ---------------------------------------------------------------------------------------
// Diferencias y fusiones
// ---------------------------------------------------------------------------------------

function lines(s: string): string[] {
  if (!s) return []
  const l = s.split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}

/** Pares (índice en a, índice en b) de líneas iguales, en orden (LCS). */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) return []
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }

function ops(a: string[], b: string[]): Op[] {
  const out: Op[] = []
  let i = 0
  let j = 0
  for (const [x, y] of [...lcs(a, b), [a.length, b.length] as [number, number]]) {
    while (i < x) out.push({ t: '-', s: a[i], ai: i++, bi: j })
    while (j < y) out.push({ t: '+', s: b[j], ai: i, bi: j++ })
    if (x < a.length) out.push({ t: ' ', s: a[x], ai: i++, bi: j++ })
  }
  return out
}

function unified(path: string, a: Entry | undefined, b: Entry | undefined, aLabel = 'a', bLabel = 'b'): string {
  const aL = lines(a?.data ?? '')
  const bL = lines(b?.data ?? '')
  let out = `diff --git ${aLabel}/${path} ${bLabel}/${path}\n`
  if (!a) out += `new file mode 100${(b!.mode & 0o777).toString(8)}\n`
  else if (!b) out += `deleted file mode 100${(a.mode & 0o777).toString(8)}\n`
  else if (a.mode !== b.mode) out += `old mode 100${(a.mode & 0o777).toString(8)}\nnew mode 100${(b.mode & 0o777).toString(8)}\n`
  out += `index ${a ? sha(a.data).slice(0, 7) : '0000000'}..${b ? sha(b.data).slice(0, 7) : '0000000'}${a && b && a.mode === b.mode ? ` 100${(a.mode & 0o777).toString(8)}` : ''}\n`
  if (a?.data === b?.data) return out
  out += `--- ${a ? `${aLabel}/${path}` : '/dev/null'}\n+++ ${b ? `${bLabel}/${path}` : '/dev/null'}\n`
  const o = ops(aL, bL)
  // Agrupar en bloques con 3 líneas de contexto.
  const changed = o.map((x, k) => (x.t !== ' ' ? k : -1)).filter((k) => k >= 0)
  let k = 0
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - 3)
    let end = Math.min(o.length - 1, changed[k] + 3)
    while (k + 1 < changed.length && changed[k + 1] - 3 <= end + 1) {
      k++
      end = Math.min(o.length - 1, changed[k] + 3)
    }
    k++
    if (start < 0) start = 0
    const chunk = o.slice(start, end + 1)
    const aStart = chunk[0].ai + 1
    const bStart = chunk[0].bi + 1
    const aCount = chunk.filter((x) => x.t !== '+').length
    const bCount = chunk.filter((x) => x.t !== '-').length
    out += `@@ -${aCount ? aStart : aStart - 1}${aCount === 1 ? '' : ',' + aCount} +${bCount ? bStart : bStart - 1}${bCount === 1 ? '' : ',' + bCount} @@\n`
    for (const x of chunk) out += `${x.t}${x.s}\n`
  }
  return out
}

function statLine(path: string, a?: Entry, b?: Entry): { path: string; add: number; del: number } {
  const o = ops(lines(a?.data ?? ''), lines(b?.data ?? ''))
  return { path, add: o.filter((x) => x.t === '+').length, del: o.filter((x) => x.t === '-').length }
}

function statText(rows: { path: string; add: number; del: number }[]): string {
  if (!rows.length) return ''
  const w = Math.max(...rows.map((r) => r.path.length))
  let out = ''
  for (const r of rows) out += ` ${r.path.padEnd(w)} | ${String(r.add + r.del).padStart(3)} ${'+'.repeat(Math.min(r.add, 40))}${'-'.repeat(Math.min(r.del, 40))}\n`
  const add = rows.reduce((n, r) => n + r.add, 0)
  const del = rows.reduce((n, r) => n + r.del, 0)
  out += ` ${rows.length} file${rows.length === 1 ? '' : 's'} changed${add ? `, ${add} insertion${add === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}\n`
  return out
}

function diffSnapshots(a: Snapshot, b: Snapshot, only?: (p: string) => boolean): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => (!only || only(p)) && !sameEntry(a.get(p), b.get(p))).sort()
}

/** Fusión de tres vías de un archivo; devuelve el texto y si quedó en conflicto. */
function merge3(base: string, ours: string, theirs: string, oursLabel: string, theirsLabel: string): { text: string; conflict: boolean } {
  const b = lines(base)
  const o = lines(ours)
  const t = lines(theirs)
  const mo = new Map(lcs(b, o))
  const mt = new Map(lcs(b, t))
  const out: string[] = []
  let conflict = false
  let i = 0
  let j = 0
  let k = 0
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, n) => v === y[n])
  for (;;) {
    let x = i
    while (x < b.length && !(mo.has(x) && mt.has(x) && mo.get(x)! >= j && mt.get(x)! >= k)) x++
    const oe = x < b.length ? mo.get(x)! : o.length
    const te = x < b.length ? mt.get(x)! : t.length
    const bc = b.slice(i, x)
    const oc = o.slice(j, oe)
    const tc = t.slice(k, te)
    if (eq(oc, bc)) out.push(...tc)
    else if (eq(tc, bc) || eq(oc, tc)) out.push(...oc)
    else {
      conflict = true
      out.push(`<<<<<<< ${oursLabel}`, ...oc, '=======', ...tc, `>>>>>>> ${theirsLabel}`)
    }
    if (x >= b.length) break
    out.push(b[x])
    i = x + 1
    j = oe + 1
    k = te + 1
  }
  return { text: out.length ? out.join('\n') + '\n' : '', conflict }
}

function ancestors(repo: Repo, id: string): Set<string> {
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    for (const p of repo.commits.get(c)?.parents ?? []) stack.push(p)
  }
  return seen
}

function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const aa = ancestors(repo, a)
  // El ancestro común más nuevo (búsqueda en anchura desde b).
  const queue = [b]
  const seen = new Set<string>()
  while (queue.length) {
    const c = queue.shift()!
    if (seen.has(c)) continue
    seen.add(c)
    if (aa.has(c)) return c
    queue.push(...(repo.commits.get(c)?.parents ?? []))
  }
  return undefined
}

// ---------------------------------------------------------------------------------------
// Revisiones
// ---------------------------------------------------------------------------------------

function resolveRev(repo: Repo, rev: string): string | undefined {
  if (!rev) return undefined
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev)!
  let base = m[1]
  const suffix = m[2]
  let id: string | undefined
  if (base === 'HEAD' || base === '@') id = repo.detached ? repo.head : repo.refs.get(repo.head)
  else
    id =
      repo.refs.get(`refs/heads/${base}`) ??
      repo.refs.get(`refs/tags/${base}`) ??
      repo.refs.get(`refs/remotes/${base}`) ??
      repo.refs.get(base) ??
      (base.length >= 4 ? [...repo.commits.keys()].find((c) => c.startsWith(base)) : undefined)
  if (base === 'ORIG_HEAD') id = repo.config.get('__orig_head')
  base = ''
  for (const s of suffix.match(/[~^]\d*/g) ?? []) {
    const n = s.length > 1 ? Number(s.slice(1)) : 1
    if (!id) return undefined
    if (s[0] === '~') for (let x = 0; x < n && id; x++) id = repo.commits.get(id)?.parents[0]
    else id = repo.commits.get(id)?.parents[n - 1]
  }
  return id
}

function short(id: string) {
  return id.slice(0, 7)
}

function fmtDate(t: number) {
  const d = new Date(t)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`
}

function decorations(repo: Repo, id: string, isHead: boolean): string {
  const out: string[] = []
  for (const [r, v] of repo.refs) {
    if (v !== id) continue
    if (r === repo.head && !repo.detached && isHead) continue
    if (r.startsWith('refs/heads/')) out.push(r.slice(11))
    else if (r.startsWith('refs/tags/')) out.push(`tag: ${r.slice(10)}`)
    else if (r.startsWith('refs/remotes/')) out.push(r.slice(13))
  }
  if (isHead) out.unshift(repo.detached ? 'HEAD' : `HEAD -> ${branchName(repo)}`)
  return out.length ? ` (${out.join(', ')})` : ''
}

/** Commits alcanzables, del más nuevo al más viejo. */
function history(repo: Repo, starts: string[]): Commit[] {
  const seen = new Set<string>()
  const out: Commit[] = []
  const stack = [...starts]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const c = repo.commits.get(id)
    if (!c) continue
    out.push(c)
    stack.push(...c.parents)
  }
  return out.sort((a, b) => b.time - a.time || (a.parents.includes(b.id) ? -1 : 1))
}

// ---------------------------------------------------------------------------------------
// Identidad y configuración
// ---------------------------------------------------------------------------------------

function globalConfigPath(ctx: CommandContext) {
  return `${ctx.sys.users.get(ctx.sh.user)?.home ?? '/root'}/.gitconfig`
}

function readIni(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const s = /^\[([^\]\s"]+)(?:\s+"([^"]+)")?\]$/.exec(line)
    if (s) {
      section = s[2] ? `${s[1]}.${s[2]}` : s[1]
      continue
    }
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line)
    if (kv && section) out.set(`${section}.${kv[1]}`.toLowerCase(), kv[2])
  }
  return out
}

function writeIni(map: Map<string, string>): string {
  const sections = new Map<string, [string, string][]>()
  for (const [k, v] of map) {
    const parts = k.split('.')
    const key = parts.pop()!
    const sec = parts.length > 1 ? `${parts[0]} "${parts.slice(1).join('.')}"` : parts[0]
    sections.set(sec, [...(sections.get(sec) ?? []), [key, v]])
  }
  return [...sections].map(([s, kv]) => `[${s}]\n${kv.map(([k, v]) => `\t${k} = ${v}`).join('\n')}\n`).join('')
}

function globalConfig(ctx: CommandContext): Map<string, string> {
  const p = globalConfigPath(ctx)
  return ctx.sys.vfs.exists(p, ROOT_CRED) ? readIni(ctx.sys.vfs.readFile(p, ROOT_CRED)) : new Map()
}

function cfg(ctx: CommandContext, repo: Repo | undefined, key: string): string | undefined {
  return repo?.config.get(key.toLowerCase()) ?? globalConfig(ctx).get(key.toLowerCase())
}

// ---------------------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------------------

function locateRemote(ctx: CommandContext, url: string): { sys: System; path: string } | string {
  let m = /^(?:ssh:\/\/)?(?:([^@/]+)@)?([^:/]+):(\/?[^:]*)$/.exec(url)
  if (url.startsWith('ssh://')) m = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?(\/.*)$/.exec(url)
  if (m && !url.startsWith('/') && !url.startsWith('.')) {
    const host = m[2]
    const ip = ctx.sys.resolveHost(host) ?? host
    const h = hostByIp(ctx.sys, ip)
    if (!h || h.poweredOff || !routeTo(ctx.sys, ip)) return `ssh: connect to host ${host} port 22: No route to host\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`
    if (inbound(h, 22, 'tcp', sourceIp(ctx.sys, ip)) !== 'ok' || !(h.services.get('ssh')?.active || h.services.get('sshd')?.active)) return `ssh: connect to host ${host} port 22: Connection refused\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`
    let path = m[3]
    const user = m[1] ?? ctx.sh.user
    if (!path.startsWith('/')) path = `${h.users.get(user)?.home ?? '/root'}/${path}`
    return { sys: h, path: normalizePath(path) }
  }
  return { sys: ctx.sys, path: normalizePath(ctx.sh.resolve(url.replace(/^file:\/\//, ''))) }
}

function openRemote(ctx: CommandContext, url: string): { sys: System; path: string; repo: Repo } | string {
  const loc = locateRemote(ctx, url)
  if (typeof loc === 'string') return loc
  const direct = repos(loc.sys).get(loc.path)
  const r = direct && loc.sys.vfs.exists(`${gitDir(loc.path, direct.bare)}/HEAD`, ROOT_CRED) ? direct : undefined
  if (!r) return `fatal: '${url}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`
  return { ...loc, repo: r }
}

function copyCommits(from: Repo, to: Repo, tips: string[]): number {
  let n = 0
  for (const id of tips) for (const c of history(from, [id])) if (!to.commits.has(c.id)) {
    to.commits.set(c.id, c)
    n++
  }
  return n
}

// ---------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------

async function runHook(ctx: CommandContext, root: string, repo: Repo, name: string, args: string[] = []): Promise<number> {
  const p = `${gitDir(root, repo.bare)}/hooks/${name}`
  const v = ctx.sys.vfs
  if (!v.exists(p, ROOT_CRED)) return 0
  const st = v.stat(p, ROOT_CRED)
  if (!(st.mode & 0o111)) {
    ctx.err(`hint: The '${p.replace(root + '/', '')}' hook was ignored because it's not set as executable.\nhint: You can disable this warning with \`git config advice.ignoredHook false\`.\n`)
    return 0
  }
  const prev = ctx.sh.cwd
  ctx.sh.cwd = root
  try {
    return await ctx.sh.exec(parse([p, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')), { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY })
  } finally {
    ctx.sh.cwd = prev
  }
}

// ---------------------------------------------------------------------------------------
// El comando
// ---------------------------------------------------------------------------------------

const NOT_REPO = 'fatal: not a git repository (or any of the parent directories): .git\n'

function makeCommit(ctx: CommandContext, repo: Repo, tree: Snapshot, parents: string[], message: string): Commit {
  const name = cfg(ctx, repo, 'user.name') ?? ''
  const email = cfg(ctx, repo, 'user.email') ?? ''
  const c: Commit = { id: sha(message + [...tree.keys()].join() + parents.join() + Date.now()), tree: new Map(tree), parents, author: name, email, time: Date.now(), message }
  repo.commits.set(c.id, c)
  return c
}

function advanceHead(repo: Repo, id: string) {
  if (repo.detached) repo.head = id
  else repo.refs.set(repo.head, id)
}

register('git', {
  usage: 'git <comando> [opciones]',
  summary:
    '  init, clone, status, add, rm, mv, commit, log, show, diff, restore, reset, revert,\n  branch, switch, checkout, merge, stash, tag, remote, fetch, pull, push, config,\n  rev-parse, blame, clean, filter-repo',
  path: '/usr/bin',
  async run(ctx) {
    const args = [...ctx.args]
    // Opciones globales: -C carpeta
    let cwd = ctx.sh.cwd
    while (args[0] === '-C' || args[0] === '-c') {
      if (args[0] === '-C') cwd = normalizePath(ctx.sh.resolve(args[1] ?? '.'))
      args.splice(0, 2)
    }
    const verb = args.shift()
    // Opciones cortas juntas (-qam = -q -a -m), como hace git.
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (/^-[a-zA-Z]{2,}$/.test(a) && !['-vv', '-fd', '-fdx', '-xdf'].includes(a)) args.splice(i, 1, ...[...a.slice(1)].map((c) => `-${c}`))
    }
    if (!verb || verb === '--help' || verb === 'help') {
      ctx.out('usage: git [-v | --version] [-h | --help] [-C <path>] <command> [<args>]\n\nThese are common Git commands used in various situations:\n\nstart a working area\n   clone     Clone a repository into a new directory\n   init      Create an empty Git repository or reinitialize an existing one\n\nwork on the current change\n   add       Add file contents to the index\n   mv        Move or rename a file, a directory, or a symlink\n   restore   Restore working tree files\n   rm        Remove files from the working tree and from the index\n\nexamine the history and state\n   diff      Show changes between commits, commit and working tree, etc\n   log       Show commit logs\n   show      Show various types of objects\n   status    Show the working tree status\n\ngrow, mark and tweak your common history\n   branch    List, create, or delete branches\n   commit    Record changes to the repository\n   merge     Join two or more development histories together\n   reset     Reset current HEAD to the specified state\n   switch    Switch branches\n   tag       Create, list, delete or verify a tag object\n\ncollaborate\n   fetch     Download objects and refs from another repository\n   pull      Fetch from and integrate with another repository or a local branch\n   push      Update remote refs along with associated objects\n')
      return 0
    }
    if (verb === '--version' || verb === 'version') {
      ctx.out(`git version ${ctx.sys.distro === 'rocky' ? '2.47.3' : '2.43.0'}\n`)
      return 0
    }
    const take = (...f: string[]): string | undefined => {
      for (const n of f) {
        const i = args.findIndex((a) => a === n || a.startsWith(n + '='))
        if (i < 0) continue
        if (args[i].includes('=') && args[i].startsWith(n + '=')) {
          const v = args[i].slice(n.length + 1)
          args.splice(i, 1)
          return v
        }
        const v = args[i + 1]
        args.splice(i, 2)
        return v
      }
      return undefined
    }
    const flag = (...f: string[]) => {
      let found = false
      for (const n of f) {
        const i = args.indexOf(n)
        if (i >= 0) {
          args.splice(i, 1)
          found = true
        }
      }
      return found
    }
    const pos = () => args.filter((a) => !a.startsWith('-') || a === '-')
    const sys = ctx.sys
    const v = sys.vfs

    // ----- sin repositorio -----
    if (verb === 'config') {
      const global = flag('--global')
      const list = flag('--list', '-l')
      const get = flag('--get')
      const unset = flag('--unset')
      const found = findRepo(sys, cwd)
      if (!global && !found && !list && !get && pos().length > 1) {
        ctx.err('fatal: not in a git directory\n')
        return 128
      }
      if (list) {
        const g = globalConfig(ctx)
        for (const [k, val] of g) ctx.out(`${k}=${val}\n`)
        if (!global && found) for (const [k, val] of found.repo.config) if (!k.startsWith('__')) ctx.out(`${k}=${val}\n`)
        return 0
      }
      const [key, ...rest] = pos()
      if (!key) {
        ctx.err('usage: git config [<options>]\n')
        return 129
      }
      const value = rest.join(' ')
      if (!value || get) {
        const val = global ? globalConfig(ctx).get(key.toLowerCase()) : cfg(ctx, found?.repo, key)
        if (unset) {
          if (global) {
            const g = globalConfig(ctx)
            g.delete(key.toLowerCase())
            v.writeFile(globalConfigPath(ctx), writeIni(g), ctx.sh.cred)
          } else found?.repo.config.delete(key.toLowerCase())
          return 0
        }
        if (val === undefined) return 1
        ctx.out(val + '\n')
        return 0
      }
      if (global) {
        const g = globalConfig(ctx)
        g.set(key.toLowerCase(), value)
        v.writeFile(globalConfigPath(ctx), writeIni(g), ctx.sh.cred)
      } else {
        found!.repo.config.set(key.toLowerCase(), value)
        const cfgPath = `${gitDir(found!.root, found!.repo.bare)}/config`
        const base = v.exists(cfgPath, ROOT_CRED) ? v.readFile(cfgPath, ROOT_CRED) : ''
        v.writeFile(cfgPath, base + `# ${key} = ${value}\n`, ROOT_CRED)
      }
      return 0
    }

    if (verb === 'init') {
      const bare = flag('--bare')
      const b = take('-b', '--initial-branch')
      flag('-q', '--quiet')
      const dir = normalizePath(ctx.sh.resolve(pos()[0] ?? cwd))
      const existing = repos(sys).get(dir)
      if (existing && v.exists(`${gitDir(dir, existing.bare)}/HEAD`, ROOT_CRED)) {
        ctx.out(`Reinitialized existing Git repository in ${gitDir(dir, existing.bare)}/\n`)
        return 0
      }
      try {
        v.mkdirp(dir, ctx.sh.cred)
      } catch {
        ctx.err(`fatal: cannot mkdir ${dir}: Permission denied\n`)
        return 128
      }
      const def = cfg(ctx, undefined, 'init.defaultBranch')
      const branch = b ?? def ?? 'master'
      if (!b && !def)
        ctx.err(
          "hint: Using 'master' as the name for the initial branch. This default branch name\nhint: is subject to change. To configure the initial branch name to use in all\nhint: of your new repositories, which will suppress this warning, call:\nhint:\nhint: \tgit config --global init.defaultBranch <name>\nhint:\nhint: Names commonly chosen instead of 'master' are 'main', 'trunk' and\nhint: 'development'. The just-created branch can be renamed via this command:\nhint:\nhint: \tgit branch -m <name>\n",
        )
      const repo = newRepo(bare, branch)
      repos(sys).set(dir, repo)
      writeGitDir(sys, dir, repo)
      ctx.out(`Initialized empty Git repository in ${gitDir(dir, bare)}/\n`)
      return 0
    }

    if (verb === 'clone') {
      const bare = flag('--bare')
      const [url, dirArg] = pos()
      if (!url) {
        ctx.err('fatal: You must specify a repository to clone.\n')
        return 129
      }
      const name = url.replace(/\/$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '')
      const dir = normalizePath(ctx.sh.resolve(dirArg ?? (bare ? `${name}.git` : name)))
      if (v.exists(dir, ROOT_CRED) && v.readdir(dir, ROOT_CRED).length) {
        ctx.err(`fatal: destination path '${dirArg ?? name}' already exists and is not an empty directory.\n`)
        return 128
      }
      ctx.err(`Cloning into ${bare ? 'bare repository ' : ''}'${dirArg ?? (bare ? `${name}.git` : name)}'...\n`)
      const remote = openRemote(ctx, url)
      if (typeof remote === 'string') {
        ctx.err(remote + '\n')
        return 128
      }
      const src = remote.repo
      const defBranch = src.head.replace('refs/heads/', '')
      const repo = newRepo(bare, defBranch)
      for (const [id, c] of src.commits) repo.commits.set(id, c)
      if (bare) for (const [r, id] of src.refs) if (r.startsWith('refs/heads/') || r.startsWith('refs/tags/')) repo.refs.set(r, id)
      if (!bare) {
        repo.remotes.set('origin', url)
        for (const [r, id] of src.refs) {
          if (r.startsWith('refs/heads/')) repo.refs.set(`refs/remotes/origin/${r.slice(11)}`, id)
          if (r.startsWith('refs/tags/')) repo.refs.set(r, id)
        }
        const tip = src.refs.get(src.head)
        if (tip) {
          repo.refs.set(`refs/heads/${defBranch}`, tip)
          repo.upstream.set(defBranch, `origin/${defBranch}`)
        }
      }
      try {
        v.mkdirp(dir, ctx.sh.cred)
      } catch {
        ctx.err(`fatal: could not create work tree dir '${dir}': Permission denied\n`)
        return 128
      }
      repos(sys).set(dir, repo)
      writeGitDir(sys, dir, repo)
      const head = headCommit(repo)
      if (!bare && head) {
        writeTree(sys, dir, new Map(), head.tree)
        repo.index = new Map(head.tree)
      }
      if (!src.commits.size) ctx.err('warning: You appear to have cloned an empty repository.\n')
      else if (!bare && !head) ctx.err('warning: remote HEAD refers to nonexistent ref, unable to checkout\n')
      else ctx.err(`remote: Enumerating objects: ${src.commits.size * 3}, done.\nremote: Counting objects: 100% (${src.commits.size * 3}/${src.commits.size * 3}), done.\nReceiving objects: 100% (${src.commits.size * 3}/${src.commits.size * 3}), done.\n`)
      return 0
    }

    const found = findRepo(sys, cwd)
    if (!found) {
      ctx.err(NOT_REPO)
      return 128
    }
    const { root, repo } = found
    const save = () => syncRefFiles(sys, root, repo)
    const rel = (p: string) => {
      const abs = normalizePath(ctx.sh.resolve(p))
      return abs === root ? '' : abs.startsWith(root + '/') ? abs.slice(root.length + 1) : undefined
    }
    const fromCwd = (p: string) => {
      const prefix = cwd === root ? '' : cwd.slice(root.length + 1) + '/'
      return p.startsWith(prefix) ? p.slice(prefix.length) : `${'../'.repeat(prefix.split('/').filter(Boolean).length)}${p}`
    }
    const needWork = () => {
      if (repo.bare) {
        ctx.err('fatal: this operation must be run in a work tree\n')
        return false
      }
      return true
    }
    const matchSpec = (specs: string[]) => {
      const rs = specs.map((s) => rel(s)).filter((x): x is string => x !== undefined)
      return (p: string) => !specs.length || rs.some((r) => r === '' || p === r || p.startsWith(r + '/') || globRe(r).test(p))
    }

    switch (verb) {
      case 'status': {
        if (!needWork()) return 128
        const shortFmt = flag('-s', '--short')
        flag('-b', '--branch')
        const work = workFiles(sys, root)
        const head = headCommit(repo)?.tree ?? new Map()
        const staged = diffSnapshots(head, repo.index)
        const unstaged = [...repo.index.keys()].filter((p) => !sameEntry(repo.index.get(p), work.get(p))).sort()
        const untracked = untrackedOf(sys, root, repo, work)
        const conflicted = repo.merging ? [...repo.index.keys()].filter((p) => /^<<<<<<< /m.test(work.get(p)?.data ?? '')) : []
        if (shortFmt) {
          const all = [...new Set([...staged, ...unstaged])].sort()
          for (const p of all) {
            if (conflicted.includes(p)) {
              ctx.out(`UU ${fromCwd(p)}\n`)
              continue
            }
            const x = staged.includes(p) ? (!head.has(p) ? 'A' : !repo.index.has(p) ? 'D' : 'M') : ' '
            const y = unstaged.includes(p) ? (!work.has(p) ? 'D' : 'M') : ' '
            ctx.out(`${x}${y} ${fromCwd(p)}\n`)
          }
          for (const p of untracked) ctx.out(`?? ${fromCwd(p)}\n`)
          return 0
        }
        let head1 = repo.detached ? `HEAD detached at ${short(repo.head)}\n` : `On branch ${branchName(repo)}\n`
        const up = repo.upstream.get(branchName(repo))
        const tip = headCommit(repo)?.id
        let upLine = ''
        if (up && tip && !repo.detached) {
          const remoteTip = repo.refs.get(`refs/remotes/${up}`)
          if (!remoteTip) upLine = `Your branch is based on '${up}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`
          else {
            const ahead = history(repo, [tip]).filter((c) => !ancestors(repo, remoteTip).has(c.id)).length
            const behind = history(repo, [remoteTip]).filter((c) => !ancestors(repo, tip).has(c.id)).length
            if (!ahead && !behind) upLine = `Your branch is up to date with '${up}'.\n`
            else if (ahead && !behind) upLine = `Your branch is ahead of '${up}' by ${ahead} commit${ahead > 1 ? 's' : ''}.\n  (use "git push" to publish your local commits)\n`
            else if (!ahead && behind) upLine = `Your branch is behind '${up}' by ${behind} commit${behind > 1 ? 's' : ''}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`
            else upLine = `Your branch and '${up}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n`
          }
        }
        head1 += upLine
        const blocks: string[] = []
        if (!headCommit(repo)) blocks.push('No commits yet\n')
        if (repo.merging) blocks.push(conflicted.length ? `You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n` : `All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n`)
        const stagedOk = staged.filter((p) => !conflicted.includes(p))
        if (stagedOk.length) blocks.push(`Changes to be committed:\n  (use "git ${headCommit(repo) ? 'restore --staged' : 'rm --cached'} <file>..." to unstage)\n` + stagedOk.map((p) => `\t${!head.has(p) ? 'new file:   ' : !repo.index.has(p) ? 'deleted:    ' : 'modified:   '}${fromCwd(p)}\n`).join(''))
        if (conflicted.length) blocks.push(`Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n` + conflicted.map((p) => `\tboth modified:   ${fromCwd(p)}\n`).join(''))
        const unstagedOk = unstaged.filter((p) => !conflicted.includes(p))
        if (unstagedOk.length) blocks.push(`Changes not staged for commit:\n  (use "git add${unstagedOk.some((p) => !work.has(p)) ? '/rm' : ''} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n` + unstagedOk.map((p) => `\t${!work.has(p) ? 'deleted:    ' : 'modified:   '}${fromCwd(p)}\n`).join(''))
        if (untracked.length) {
          let u = `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n`
          const shown = new Set<string>()
          for (const p of untracked) {
            // Como git: una carpeta entera sin versionar se muestra como carpeta.
            const parts = p.split('/')
            let label = p
            for (let i = 1; i < parts.length; i++) {
              const d = parts.slice(0, i).join('/')
              if (![...repo.index.keys()].some((x) => x.startsWith(d + '/'))) {
                label = d + '/'
                break
              }
            }
            if (!shown.has(label)) {
              shown.add(label)
              u += `\t${fromCwd(label)}\n`
            }
          }
          blocks.push(u)
        }
        let tail = ''
        if (!stagedOk.length && !unstagedOk.length && !conflicted.length) {
          if (untracked.length) tail = `nothing added to commit but untracked files present (use "git add" to track)\n`
          else if (!headCommit(repo)) tail = `nothing to commit (create/copy files and use "git add" to track)\n`
          else if (!repo.merging) tail = `nothing to commit, working tree clean\n`
        } else if (!stagedOk.length) tail = `no changes added to commit (use "git add" and/or "git commit -a")\n`
        // Como git: bloques separados por una línea en blanco; "nothing to commit" va pegado si no hay bloques.
        let out = head1 + (upLine && blocks.length ? '\n' : '') + blocks.join('\n')
        if (tail) out += (blocks.length && (untracked.length || !stagedOk.length) ? '\n' : '') + tail
        ctx.out(out)
        return 0
      }
      case 'add': {
        if (!needWork()) return 128
        const all = flag('-A', '--all')
        const update = flag('-u', '--update')
        const force = flag('-f', '--force')
        flag('-v')
        const specs = pos()
        if (!specs.length && !all && !update) {
          ctx.err('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?\n')
          return 0
        }
        const work = workFiles(sys, root)
        const rules = ignoreRules(sys, root)
        const match = matchSpec(all || update ? [] : specs)
        for (const s of specs) {
          const r = rel(s)
          if (r === undefined) {
            ctx.err(`fatal: ${s}: '${s}' is outside repository at '${root}'\n`)
            return 128
          }
          if (r && !work.has(r) && ![...work.keys()].some((p) => p.startsWith(r + '/')) && !repo.index.has(r) && !globRe(r).source.includes('*')) {
            ctx.err(`fatal: pathspec '${s}' did not match any files\n`)
            return 128
          }
          if (r && work.has(r) && isIgnored(rules, r, false) && !force) {
            ctx.err(`The following paths are ignored by one of your .gitignore files:\n${s}\nhint: Use -f if you really want to add them.\nhint: Turn this message off by running\nhint: "git config advice.addIgnoredFile false"\n`)
            return 1
          }
        }
        for (const [p, e] of work) {
          if (!match(p)) continue
          if (!repo.index.has(p) && (update || (isIgnored(rules, p, false) && !force))) continue
          repo.index.set(p, e)
        }
        for (const p of [...repo.index.keys()]) if (match(p) && !work.has(p)) repo.index.delete(p)
        return 0
      }
      case 'rm': {
        const cached = flag('--cached')
        const recursive = flag('-r')
        flag('-f', '--force', '-q')
        const match = matchSpec(pos())
        const targets = [...repo.index.keys()].filter(match)
        if (!targets.length) {
          ctx.err(`fatal: pathspec '${pos()[0] ?? ''}' did not match any files\n`)
          return 128
        }
        if (!recursive && targets.some((t) => !pos().some((s) => rel(s) === t))) {
          ctx.err(`fatal: not removing '${pos()[0]}' recursively without -r\n`)
          return 128
        }
        for (const t of targets) {
          repo.index.delete(t)
          if (!cached && v.exists(`${root}/${t}`, ROOT_CRED)) v.unlink(`${root}/${t}`, ROOT_CRED)
          ctx.out(`rm '${fromCwd(t)}'\n`)
        }
        return 0
      }
      case 'mv': {
        const [a, b] = pos()
        const ra = rel(a ?? '')
        const rb = rel(b ?? '')
        if (!ra || rb === undefined || !repo.index.has(ra)) {
          ctx.err(`fatal: not under version control, source=${a}, destination=${b}\n`)
          return 128
        }
        v.rename(`${root}/${ra}`, `${root}/${rb}`, ROOT_CRED)
        repo.index.set(rb, repo.index.get(ra)!)
        repo.index.delete(ra)
        return 0
      }
      case 'commit': {
        if (!needWork()) return 128
        const msgs: string[] = []
        for (let m = take('-m', '--message'); m !== undefined; m = take('-m', '--message')) msgs.push(m)
        const allFlag = flag('-a', '--all')
        const amend = flag('--amend')
        const noEdit = flag('--no-edit')
        const noVerify = flag('--no-verify', '-n')
        const allowEmpty = flag('--allow-empty')
        flag('-q', '--quiet', '-v')
        if (!cfg(ctx, repo, 'user.email') || !cfg(ctx, repo, 'user.name')) {
          ctx.err(`Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address (got '${ctx.sh.user}@${sys.hostname}.(none)')\n`)
          return 128
        }
        if (allFlag) {
          const work = workFiles(sys, root)
          for (const p of [...repo.index.keys()]) {
            if (work.has(p)) repo.index.set(p, work.get(p)!)
            else repo.index.delete(p)
          }
        }
        const parent = headCommit(repo)
        if (repo.merging) {
          const work = workFiles(sys, root)
          const unresolved = [...repo.index.keys()].filter((p) => /^<<<<<<< /m.test(repo.index.get(p)?.data ?? '') || (/^<<<<<<< /m.test(work.get(p)?.data ?? '') && !sameEntry(work.get(p), repo.index.get(p))))
          if ([...repo.index.values()].some((e) => /^<<<<<<< /m.test(e.data)) && unresolved.length) {
            // Se agregaron con marcas: git lo permite, pero avisamos.
          }
          const pending = [...repo.index.keys()].filter((p) => /^<<<<<<< /m.test(work.get(p)?.data ?? '') && !sameEntry(work.get(p), repo.index.get(p)))
          if (pending.length) {
            ctx.err(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n${pending.map((p) => `U\t${p}`).join('\n')}\n`)
            return 128
          }
        }
        if (!msgs.length && !(amend && noEdit) && !repo.merging) {
          ctx.err('[simulador] El editor para escribir el mensaje no está: usá git commit -m "mensaje".\nAborting commit due to empty commit message.\n')
          return 1
        }
        const base = amend ? parent?.parents[0] : parent?.id
        const baseTree = (base ? repo.commits.get(base)?.tree : undefined) ?? new Map()
        if (!amend && !repo.merging && !allowEmpty && parent && !diffSnapshots(parent.tree, repo.index).length) {
          const work = workFiles(sys, root)
          const changed = [...repo.index.keys()].filter((p) => !sameEntry(repo.index.get(p), work.get(p)))
          const untracked = untrackedOf(sys, root, repo, work)
          ctx.out(`On branch ${branchName(repo)}\n${changed.length ? `Changes not staged for commit:\n${changed.map((p) => `\tmodified:   ${p}\n`).join('')}\nno changes added to commit (use "git add" and/or "git commit -a")\n` : untracked.length ? `Untracked files:\n${untracked.map((p) => `\t${p}\n`).join('')}\nnothing added to commit but untracked files present (use "git add" to track)\n` : 'nothing to commit, working tree clean\n'}`)
          return 1
        }
        if (!parent && !repo.index.size && !allowEmpty) {
          ctx.out(`On branch ${branchName(repo)}\n\nInitial commit\n\nnothing to commit (create/copy files and use "git add" to track)\n`)
          return 1
        }
        if (!noVerify) {
          const code = await runHook(ctx, root, repo, 'pre-commit')
          if (code !== 0) return 1
        }
        let message = msgs.join('\n\n') || (amend && parent ? parent.message : repo.merging ? `Merge branch '${repo.merging.label}'` : '')
        if (!noVerify) {
          const g = gitDir(root, repo.bare)
          v.writeFile(`${g}/COMMIT_EDITMSG`, message + '\n', ROOT_CRED)
          const code = await runHook(ctx, root, repo, 'commit-msg', [`${g}/COMMIT_EDITMSG`])
          if (code !== 0) return 1
          message = v.readFile(`${g}/COMMIT_EDITMSG`, ROOT_CRED).replace(/\n$/, '')
        }
        const parents = amend ? (parent?.parents ?? []) : [...(parent ? [parent.id] : []), ...(repo.merging ? [repo.merging.other] : [])]
        const c = makeCommit(ctx, repo, repo.index, parents, message)
        advanceHead(repo, c.id)
        const wasMerge = !!repo.merging
        repo.merging = undefined
        save()
        const rows = diffSnapshots(baseTree, c.tree).map((p) => statLine(p, baseTree.get(p), c.tree.get(p)))
        const adds = rows.reduce((n, r) => n + r.add, 0)
        const dels = rows.reduce((n, r) => n + r.del, 0)
        ctx.out(`[${repo.detached ? `detached HEAD ${short(c.id)}` : `${branchName(repo)}${parents.length ? '' : ' (root-commit)'} ${short(c.id)}`}] ${message.split('\n')[0]}\n${wasMerge ? '' : ` ${rows.length} file${rows.length === 1 ? '' : 's'} changed${adds ? `, ${adds} insertion${adds === 1 ? '' : 's'}(+)` : ''}${dels ? `, ${dels} deletion${dels === 1 ? '' : 's'}(-)` : ''}\n`}${diffSnapshots(baseTree, c.tree)
          .filter((p) => !baseTree.has(p) || !c.tree.has(p))
          .map((p) => ` ${baseTree.has(p) ? 'delete' : 'create'} mode 100${((c.tree.get(p) ?? baseTree.get(p))!.mode & 0o777).toString(8)} ${p}\n`)
          .join('')}`)
        return 0
      }
      case 'log': {
        const oneline = flag('--oneline')
        const graph = flag('--graph')
        const all = flag('--all')
        const stat = flag('--stat')
        const patch = flag('-p', '--patch')
        flag('--decorate')
        const n = take('-n', '--max-count')
        const nShort = args.find((a) => /^-\d+$/.test(a))
        if (nShort) args.splice(args.indexOf(nShort), 1)
        const pick = take('-S')
        const grep = take('-G')
        const author = take('--author')
        const fmt = take('--format', '--pretty')
        const ddash = args.indexOf('--')
        const paths = ddash >= 0 ? args.splice(ddash).slice(1) : []
        const revs = pos().filter((p) => {
          if (resolveRev(repo, p.split('..').pop()!)) return true
          paths.push(p)
          return false
        })
        let starts: string[] = []
        let exclude = new Set<string>()
        if (all) starts = [...new Set([...repo.refs.values()])]
        else if (revs.length) {
          for (const r of revs) {
            if (r.includes('..')) {
              const [a, b] = r.split('..')
              const ai = resolveRev(repo, a || 'HEAD')
              const bi = resolveRev(repo, b || 'HEAD')
              if (bi) starts.push(bi)
              if (ai) exclude = ancestors(repo, ai)
            } else starts.push(resolveRev(repo, r)!)
          }
        } else {
          const h = headCommit(repo)
          if (!h) {
            ctx.err(`fatal: your current branch '${branchName(repo)}' does not have any commits yet\n`)
            return 128
          }
          starts = [h.id]
        }
        const match = matchSpec(paths)
        let list = history(repo, starts).filter((c) => !exclude.has(c.id))
        const parentTree = (c: Commit) => (c.parents[0] ? repo.commits.get(c.parents[0])!.tree : new Map<string, Entry>())
        if (paths.length) list = list.filter((c) => diffSnapshots(parentTree(c), c.tree, match).length)
        if (author) list = list.filter((c) => c.author.includes(author) || c.email.includes(author))
        if (pick) {
          const count = (t: Snapshot) => [...t.values()].reduce((k, e) => k + e.data.split(pick).length - 1, 0)
          list = list.filter((c) => count(c.tree) !== count(parentTree(c)))
        }
        if (grep) {
          const re = new RegExp(grep)
          list = list.filter((c) => diffSnapshots(parentTree(c), c.tree).some((p) => ops(lines(parentTree(c).get(p)?.data ?? ''), lines(c.tree.get(p)?.data ?? '')).some((o) => o.t !== ' ' && re.test(o.s))))
        }
        const max = Number(n ?? nShort?.slice(1) ?? Infinity)
        list = list.slice(0, max)
        const headId = headCommit(repo)?.id
        let out = ''
        for (const c of list) {
          const dec = decorations(repo, c.id, c.id === headId)
          const g = graph ? (c.parents.length > 1 ? '*   ' : '* ') : ''
          if (fmt) {
            const f = fmt.replace(/^format:/, '').replace(/^tformat:/, '')
            out += f.replace(/%H/g, c.id).replace(/%h/g, short(c.id)).replace(/%s/g, c.message.split('\n')[0]).replace(/%an/g, c.author).replace(/%ae/g, c.email).replace(/%ad/g, fmtDate(c.time)).replace(/%ar/g, 'hace un momento').replace(/%d/g, dec) + '\n'
            continue
          }
          if (oneline) out += `${g}${short(c.id)}${dec} ${c.message.split('\n')[0]}\n`
          else {
            const pre = graph ? '| ' : ''
            out += `${g}commit ${c.id}${dec}\n${c.parents.length > 1 ? `${pre}Merge: ${c.parents.map(short).join(' ')}\n` : ''}${pre}Author: ${c.author} <${c.email}>\n${pre}Date:   ${fmtDate(c.time)}\n${pre}\n${c.message.split('\n').map((l) => `${pre}    ${l}`).join('\n')}\n${pre}\n`
          }
          if (stat || patch) {
            const pt = parentTree(c)
            const files = diffSnapshots(pt, c.tree)
            if (stat) out += statText(files.map((p) => statLine(p, pt.get(p), c.tree.get(p)))) + '\n'
            if (patch) out += files.map((p) => unified(p, pt.get(p), c.tree.get(p))).join('') + '\n'
          }
        }
        ctx.out(out)
        return 0
      }
      case 'show': {
        const stat = flag('--stat')
        const nameOnly = flag('--name-only')
        const spec = pos()[0] ?? 'HEAD'
        const [rv, file] = spec.includes(':') ? spec.split(':') : [spec, undefined]
        const id = resolveRev(repo, rv || 'HEAD')
        const c = id ? repo.commits.get(id) : undefined
        if (!c) {
          ctx.err(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\n`)
          return 128
        }
        if (file !== undefined) {
          const e = c.tree.get(file)
          if (!e) {
            ctx.err(`fatal: path '${file}' does not exist in '${rv}'\n`)
            return 128
          }
          ctx.out(e.data)
          return 0
        }
        const pt = c.parents[0] ? repo.commits.get(c.parents[0])!.tree : new Map<string, Entry>()
        const files = diffSnapshots(pt, c.tree)
        let out = `commit ${c.id}${decorations(repo, c.id, c.id === headCommit(repo)?.id)}\nAuthor: ${c.author} <${c.email}>\nDate:   ${fmtDate(c.time)}\n\n${c.message.split('\n').map((l) => `    ${l}`).join('\n')}\n\n`
        if (nameOnly) out += files.join('\n') + '\n'
        else if (stat) out += statText(files.map((p) => statLine(p, pt.get(p), c.tree.get(p))))
        else out += files.map((p) => unified(p, pt.get(p), c.tree.get(p))).join('')
        ctx.out(out)
        return 0
      }
      case 'diff': {
        const staged = flag('--staged', '--cached')
        const stat = flag('--stat')
        const nameOnly = flag('--name-only')
        const ddash = args.indexOf('--')
        const paths = ddash >= 0 ? args.splice(ddash).slice(1) : []
        const revs: string[] = []
        for (const p of pos()) {
          if (p.includes('..') || resolveRev(repo, p)) revs.push(p)
          else paths.push(p)
        }
        const match = matchSpec(paths)
        let a: Snapshot
        let b: Snapshot
        const work = () => {
          const w = workFiles(sys, root)
          // Solo los versionados.
          return new Map([...w].filter(([p]) => repo.index.has(p)))
        }
        if (revs.length === 1 && revs[0].includes('..')) {
          const [x, y] = revs[0].split(/\.\.\.?/)
          a = repo.commits.get(resolveRev(repo, x || 'HEAD') ?? '')?.tree ?? new Map()
          b = repo.commits.get(resolveRev(repo, y || 'HEAD') ?? '')?.tree ?? new Map()
        } else if (revs.length === 2) {
          a = repo.commits.get(resolveRev(repo, revs[0])!)!.tree
          b = repo.commits.get(resolveRev(repo, revs[1])!)!.tree
        } else if (revs.length === 1) {
          a = repo.commits.get(resolveRev(repo, revs[0])!)!.tree
          b = staged ? repo.index : work()
        } else if (staged) {
          a = headCommit(repo)?.tree ?? new Map()
          b = repo.index
        } else {
          a = repo.index
          b = work()
          for (const p of a.keys()) if (!b.has(p)) b.delete(p)
        }
        const files = diffSnapshots(a, b, match)
        if (nameOnly) ctx.out(files.map((f) => f + '\n').join(''))
        else if (stat) ctx.out(statText(files.map((p) => statLine(p, a.get(p), b.get(p)))))
        else ctx.out(files.map((p) => unified(p, a.get(p), b.get(p))).join(''))
        return 0
      }
      case 'restore': {
        const stagedF = flag('--staged', '-S')
        const workF = flag('--worktree', '-W')
        const source = take('--source', '-s')
        const match = matchSpec(pos())
        if (!pos().length) {
          ctx.err('fatal: you must specify path(s) to restore\n')
          return 128
        }
        const src = source ? repo.commits.get(resolveRev(repo, source) ?? '')?.tree : undefined
        if (source && !src) {
          ctx.err(`fatal: could not resolve ${source}\n`)
          return 128
        }
        const head = headCommit(repo)?.tree ?? new Map()
        const doIndex = stagedF
        const doWork = workF || !stagedF
        let hits = 0
        if (doIndex) {
          const from = src ?? head
          for (const p of new Set([...repo.index.keys(), ...from.keys()])) {
            if (!match(p)) continue
            hits++
            if (from.has(p)) repo.index.set(p, from.get(p)!)
            else repo.index.delete(p)
          }
        }
        if (doWork) {
          const from = src ?? repo.index
          for (const [p, e] of from) {
            if (!match(p)) continue
            hits++
            putFile(sys, root, p, e)
          }
        }
        if (!hits) {
          ctx.err(`error: pathspec '${pos()[0]}' did not match any file(s) known to git\n`)
          return 1
        }
        return 0
      }
      case 'reset': {
        const hard = flag('--hard')
        const soft = flag('--soft')
        flag('--mixed', '-q')
        const ddash = args.indexOf('--')
        const paths = ddash >= 0 ? args.splice(ddash).slice(1) : []
        const p = pos()
        const target = p[0] && resolveRev(repo, p[0]) ? p.shift()! : 'HEAD'
        paths.push(...p)
        if (paths.length) {
          const from = repo.commits.get(resolveRev(repo, target) ?? '')?.tree ?? new Map()
          const match = matchSpec(paths)
          for (const q of new Set([...repo.index.keys(), ...from.keys()])) {
            if (!match(q)) continue
            if (from.has(q)) repo.index.set(q, from.get(q)!)
            else repo.index.delete(q)
          }
          ctx.out(`Unstaged changes after reset:\n`)
          return 0
        }
        const id = resolveRev(repo, target)
        const c = id ? repo.commits.get(id) : undefined
        if (!c) {
          ctx.err(`fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.\n`)
          return 128
        }
        const before = headCommit(repo)
        if (before) repo.config.set('__orig_head', before.id)
        advanceHead(repo, c.id)
        repo.merging = undefined
        if (!soft) {
          const oldIndex = repo.index
          repo.index = new Map(c.tree)
          if (hard) {
            writeTree(sys, root, oldIndex, c.tree)
            ctx.out(`HEAD is now at ${short(c.id)} ${c.message.split('\n')[0]}\n`)
          }
        }
        save()
        return 0
      }
      case 'revert': {
        flag('--no-edit')
        const id = resolveRev(repo, pos()[0] ?? '')
        const c = id ? repo.commits.get(id) : undefined
        const head = headCommit(repo)
        if (!c || !head) {
          ctx.err(`fatal: bad revision '${pos()[0] ?? ''}'\n`)
          return 128
        }
        const parent = c.parents[0] ? repo.commits.get(c.parents[0])!.tree : new Map<string, Entry>()
        // Aplicar el cambio inverso: fusión de tres vías con base = el commit, "ellos" = su padre.
        const result = new Map(head.tree)
        let conflict = false
        for (const p of diffSnapshots(c.tree, parent)) {
          const ours = head.tree.get(p)
          const want = parent.get(p)
          const was = c.tree.get(p)
          if (sameEntry(ours, was)) {
            if (want) result.set(p, want)
            else result.delete(p)
          } else if (ours && want && was) {
            const m = merge3(was.data, ours.data, want.data, 'HEAD', `parent of ${short(c.id)} (${c.message.split('\n')[0]})`)
            result.set(p, { data: m.text, mode: ours.mode })
            conflict ||= m.conflict
          } else conflict = true
        }
        writeTree(sys, root, repo.index, result)
        repo.index = new Map(result)
        if (conflict) {
          repo.merging = { other: head.id, label: `revert ${short(c.id)}` }
          ctx.err(`error: could not revert ${short(c.id)}... ${c.message.split('\n')[0]}\nhint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git revert --continue".\n`)
          return 1
        }
        const nc = makeCommit(ctx, repo, result, [head.id], `Revert "${c.message.split('\n')[0]}"\n\nThis reverts commit ${c.id}.`)
        advanceHead(repo, nc.id)
        save()
        const rows = diffSnapshots(head.tree, result).map((p) => statLine(p, head.tree.get(p), result.get(p)))
        ctx.out(`[${branchName(repo)} ${short(nc.id)}] Revert "${c.message.split('\n')[0]}"\n${statText(rows).split('\n').slice(-2).join('\n')}`)
        return 0
      }
      case 'branch': {
        const del = flag('-d', '--delete')
        const force = flag('-D')
        const move = flag('-m', '-M', '--move')
        const allB = flag('-a', '--all')
        const remotesOnly = flag('-r', '--remotes')
        const verbose = flag('-v', '-vv', '--verbose')
        const upstreamTo = take('-u', '--set-upstream-to')
        flag('--list')
        const p = pos()
        if (upstreamTo) {
          repo.upstream.set(p[0] ?? branchName(repo), upstreamTo)
          ctx.out(`branch '${p[0] ?? branchName(repo)}' set up to track '${upstreamTo}'.\n`)
          return 0
        }
        if (del || force) {
          for (const b of p) {
            const id = repo.refs.get(`refs/heads/${b}`)
            if (!id) {
              ctx.err(`error: branch '${b}' not found\n`)
              return 1
            }
            if (`refs/heads/${b}` === repo.head) {
              ctx.err(`error: cannot delete branch '${b}' used by worktree at '${root}'\n`)
              return 1
            }
            const h = headCommit(repo)
            if (!force && h && !ancestors(repo, h.id).has(id)) {
              ctx.err(`error: the branch '${b}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${b}'\n`)
              return 1
            }
            repo.refs.delete(`refs/heads/${b}`)
            ctx.out(`Deleted branch ${b} (was ${short(id)}).\n`)
          }
          save()
          return 0
        }
        if (move) {
          const [from, to] = p.length === 2 ? p : [branchName(repo), p[0]]
          const id = repo.refs.get(`refs/heads/${from}`)
          if (`refs/heads/${from}` === repo.head) repo.head = `refs/heads/${to}`
          if (id) {
            repo.refs.delete(`refs/heads/${from}`)
            repo.refs.set(`refs/heads/${to}`, id)
          }
          if (repo.upstream.has(from)) {
            repo.upstream.set(to, repo.upstream.get(from)!)
            repo.upstream.delete(from)
          }
          save()
          return 0
        }
        if (p.length) {
          const id = resolveRev(repo, p[1] ?? 'HEAD')
          if (!id) {
            ctx.err(`fatal: not a valid object name: '${p[1] ?? branchName(repo)}'\n`)
            return 128
          }
          if (repo.refs.has(`refs/heads/${p[0]}`)) {
            ctx.err(`fatal: a branch named '${p[0]}' already exists\n`)
            return 128
          }
          repo.refs.set(`refs/heads/${p[0]}`, id)
          save()
          return 0
        }
        const rows: string[] = []
        for (const [r, id] of [...repo.refs].sort(([a], [b]) => a.localeCompare(b))) {
          const isLocal = r.startsWith('refs/heads/')
          const isRemote = r.startsWith('refs/remotes/')
          if (!(isLocal && !remotesOnly) && !(isRemote && (allB || remotesOnly))) continue
          const name = isLocal ? r.slice(11) : allB ? `remotes/${r.slice(13)}` : r.slice(13)
          const cur = r === repo.head && !repo.detached
          const c = repo.commits.get(id)
          rows.push(`${cur ? '* ' : '  '}${name}${verbose ? ` ${short(id)} ${isLocal && repo.upstream.has(r.slice(11)) ? `[${repo.upstream.get(r.slice(11))}] ` : ''}${c?.message.split('\n')[0] ?? ''}` : ''}`)
        }
        if (repo.detached) rows.unshift(`* (HEAD detached at ${short(repo.head)})`)
        ctx.out(rows.map((r) => r + '\n').join(''))
        return 0
      }
      case 'switch':
      case 'checkout': {
        const create = take('-c', '-b', '--create')
        const createForce = take('-C', '-B')
        const detach = flag('--detach')
        flag('-q', '--quiet')
        const ddash = args.indexOf('--')
        if (verb === 'checkout' && ddash >= 0) {
          const paths = args.splice(ddash).slice(1)
          const rev = pos()[0]
          const from = rev ? repo.commits.get(resolveRev(repo, rev) ?? '')?.tree ?? new Map() : repo.index
          const match = matchSpec(paths)
          for (const [p, e] of from) if (match(p)) {
            putFile(sys, root, p, e)
            if (rev) repo.index.set(p, e)
          }
          return 0
        }
        const target = create ?? createForce ?? pos()[0]
        if (!target) {
          ctx.err(`fatal: missing branch or commit argument\n`)
          return 128
        }
        // checkout de un archivo sin "--"
        if (verb === 'checkout' && !create && !createForce && !resolveRev(repo, target) && !repo.refs.has(`refs/remotes/origin/${target}`)) {
          const r = rel(target)
          if (r !== undefined && repo.index.has(r)) {
            putFile(sys, root, r, repo.index.get(r)!)
            ctx.err(`Updated 1 path from the index\n`)
            return 0
          }
        }
        let id: string | undefined
        let newBranch: string | undefined
        if (create || createForce) {
          if (create && repo.refs.has(`refs/heads/${create}`)) {
            ctx.err(`fatal: a branch named '${create}' already exists\n`)
            return 128
          }
          id = resolveRev(repo, pos()[0] ?? 'HEAD') ?? headCommit(repo)?.id
          newBranch = target
        } else if (repo.refs.has(`refs/heads/${target}`)) id = repo.refs.get(`refs/heads/${target}`)
        else if (repo.refs.has(`refs/remotes/origin/${target}`) && !detach) {
          id = repo.refs.get(`refs/remotes/origin/${target}`)
          newBranch = target
          repo.upstream.set(target, `origin/${target}`)
          ctx.out(`branch '${target}' set up to track 'origin/${target}'.\n`)
        } else {
          id = resolveRev(repo, target)
          if (id && verb === 'switch' && !detach) {
            ctx.err(`fatal: a branch is expected, got commit '${target}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.\n`)
            return 128
          }
        }
        if (!id && !(newBranch && !headCommit(repo))) {
          ctx.err(verb === 'switch' ? `fatal: invalid reference: ${target}\n` : `error: pathspec '${target}' did not match any file(s) known to git\n`)
          return 1
        }
        const to = id ? repo.commits.get(id)!.tree : new Map<string, Entry>()
        // Cambios sin guardar que se pisarían.
        const work = workFiles(sys, root)
        const head = headCommit(repo)?.tree ?? new Map()
        const dirty = [...repo.index.keys()].filter((p) => !sameEntry(repo.index.get(p), work.get(p)) || !sameEntry(repo.index.get(p), head.get(p)))
        const clash = dirty.filter((p) => !sameEntry(head.get(p), to.get(p)))
        if (clash.length) {
          ctx.err(`error: Your local changes to the following files would be overwritten by checkout:\n${clash.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you switch branches.\nAborting\n`)
          return 1
        }
        // Aplicar: lo que cambia entre HEAD y el destino; los cambios locales que no chocan quedan.
        for (const p of new Set([...head.keys(), ...to.keys()])) {
          if (sameEntry(head.get(p), to.get(p))) continue
          const abs = `${root}/${p}`
          if (to.has(p)) {
            putFile(sys, root, p, to.get(p)!)
            repo.index.set(p, to.get(p)!)
          } else {
            if (v.exists(abs, ROOT_CRED)) v.unlink(abs, ROOT_CRED)
            repo.index.delete(p)
          }
        }
        if (newBranch) {
          if (id) repo.refs.set(`refs/heads/${newBranch}`, id)
          repo.head = `refs/heads/${newBranch}`
          repo.detached = false
          ctx.err(`Switched to a new branch '${newBranch}'\n`)
        } else if (repo.refs.has(`refs/heads/${target}`)) {
          const already = repo.head === `refs/heads/${target}` && !repo.detached
          repo.head = `refs/heads/${target}`
          repo.detached = false
          ctx.err(already ? `Already on '${target}'\n` : `Switched to branch '${target}'\n`)
          const up = repo.upstream.get(target)
          if (up && !already) {
            const rt = repo.refs.get(`refs/remotes/${up}`)
            if (rt === id) ctx.out(`Your branch is up to date with '${up}'.\n`)
          }
        } else {
          repo.head = id!
          repo.detached = true
          ctx.err(`Note: switching to '${target}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\nHEAD is now at ${short(id!)} ${repo.commits.get(id!)!.message.split('\n')[0]}\n`)
        }
        save()
        return 0
      }
      case 'merge': {
        if (flag('--abort')) {
          if (!repo.merging) {
            ctx.err('fatal: There is no merge to abort (MERGE_HEAD missing).\n')
            return 128
          }
          const h = headCommit(repo)!
          writeTree(sys, root, workFiles(sys, root), h.tree)
          repo.index = new Map(h.tree)
          repo.merging = undefined
          return 0
        }
        const noFf = flag('--no-ff')
        const ffOnly = flag('--ff-only')
        const msg = take('-m')
        flag('--no-edit')
        const name = pos()[0]
        const other = name ? resolveRev(repo, name) : undefined
        const head = headCommit(repo)
        if (!other || !head) {
          ctx.err(`merge: ${name ?? ''} - not something we can merge\n`)
          return 1
        }
        if (repo.merging) {
          ctx.err('error: Merging is not possible because you have unmerged files.\n')
          return 128
        }
        const work = workFiles(sys, root)
        if ([...repo.index.keys()].some((p) => !sameEntry(repo.index.get(p), head.tree.get(p)) || !sameEntry(repo.index.get(p), work.get(p)))) {
          ctx.err(`error: Your local changes to the following files would be overwritten by merge:\n${[...repo.index.keys()].filter((p) => !sameEntry(repo.index.get(p), work.get(p))).map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting\n`)
          return 1
        }
        if (ancestors(repo, head.id).has(other)) {
          ctx.out('Already up to date.\n')
          return 0
        }
        const oc = repo.commits.get(other)!
        const fast = ancestors(repo, other).has(head.id)
        if (fast && !noFf) {
          const rows = diffSnapshots(head.tree, oc.tree).map((p) => statLine(p, head.tree.get(p), oc.tree.get(p)))
          writeTree(sys, root, head.tree, oc.tree)
          repo.index = new Map(oc.tree)
          advanceHead(repo, other)
          save()
          ctx.out(`Updating ${short(head.id)}..${short(other)}\nFast-forward\n${statText(rows)}`)
          return 0
        }
        if (ffOnly) {
          ctx.err('fatal: Not possible to fast-forward, aborting.\n')
          return 128
        }
        const baseId = mergeBase(repo, head.id, other)
        const base = baseId ? repo.commits.get(baseId)!.tree : new Map<string, Entry>()
        const result = new Map<string, Entry>()
        const conflicts: string[] = []
        for (const p of new Set([...base.keys(), ...head.tree.keys(), ...oc.tree.keys()])) {
          const b = base.get(p)
          const o = head.tree.get(p)
          const t = oc.tree.get(p)
          if (sameEntry(o, t)) {
            if (o) result.set(p, o)
          } else if (sameEntry(b, o) || (!b && !o)) {
            if (t) result.set(p, t)
          } else if (sameEntry(b, t) || (!b && !t)) {
            if (o) result.set(p, o)
          } else if (o && t) {
            const m = merge3(b?.data ?? '', o.data, t.data, 'HEAD', name)
            result.set(p, { data: m.text, mode: o.mode })
            if (m.conflict) conflicts.push(p)
          } else {
            // Borrado de un lado y cambiado del otro.
            result.set(p, (o ?? t)!)
            conflicts.push(p)
          }
        }
        writeTree(sys, root, head.tree, result)
        const auto = diffSnapshots(base, oc.tree).filter((p) => head.tree.has(p) && oc.tree.has(p) && base.has(p) && !sameEntry(head.tree.get(p), base.get(p)))
        for (const p of auto) ctx.out(`Auto-merging ${p}\n`)
        if (conflicts.length) {
          // En el índice quedan las versiones sin marcas (las de HEAD) hasta que se resuelve.
          repo.index = new Map([...result].map(([p, e]) => [p, conflicts.includes(p) ? head.tree.get(p) ?? e : e]))
          repo.merging = { other, label: name }
          for (const p of conflicts) ctx.out(`CONFLICT (content): Merge conflict in ${p}\n`)
          ctx.out('Automatic merge failed; fix conflicts and then commit the result.\n')
          return 1
        }
        repo.index = new Map(result)
        const mc = makeCommit(ctx, repo, result, [head.id, other], msg ?? `Merge branch '${name}'${branchName(repo) !== 'main' && branchName(repo) !== 'master' ? ` into ${branchName(repo)}` : ''}`)
        advanceHead(repo, mc.id)
        save()
        const rows = diffSnapshots(head.tree, result).map((p) => statLine(p, head.tree.get(p), result.get(p)))
        ctx.out(`Merge made by the 'ort' strategy.\n${statText(rows)}`)
        return 0
      }
      case 'stash': {
        const sub = args[0] && !args[0].startsWith('-') ? args.shift()! : 'push'
        const msg = take('-m', '--message')
        const head = headCommit(repo)
        if (sub === 'list') {
          ctx.out(repo.stash.map((s, i) => `stash@{${i}}: ${s.msg}\n`).join(''))
          return 0
        }
        if (sub === 'push' || sub === 'save') {
          if (!head) {
            ctx.err("You do not have the initial commit yet\n")
            return 1
          }
          const work = workFiles(sys, root)
          const tracked = new Map([...work].filter(([p]) => repo.index.has(p) || head.tree.has(p)))
          if (!diffSnapshots(head.tree, tracked).length && !diffSnapshots(head.tree, repo.index).length) {
            ctx.out('No local changes to save\n')
            return 0
          }
          const label = `${msg ? `On ${branchName(repo)}: ${msg}` : `WIP on ${branchName(repo)}: ${short(head.id)} ${head.message.split('\n')[0]}`}`
          repo.stash.unshift({ work: tracked, index: new Map(repo.index), base: head.id, msg: label })
          writeTree(sys, root, tracked, head.tree)
          repo.index = new Map(head.tree)
          ctx.out(`Saved working directory and index state ${label}\n`)
          return 0
        }
        if (sub === 'pop' || sub === 'apply') {
          const s = repo.stash[0]
          if (!s) {
            ctx.err('No stash entries found.\n')
            return 1
          }
          const work = workFiles(sys, root)
          for (const [p, e] of s.work) {
            const cur = work.get(p)
            const base = repo.commits.get(s.base)?.tree.get(p)
            if (cur && base && !sameEntry(cur, base) && !sameEntry(cur, e)) {
              const m = merge3(base.data, cur.data, e.data, 'Updated upstream', 'Stashed changes')
              putFile(sys, root, p, { data: m.text, mode: e.mode })
              if (m.conflict) ctx.out(`CONFLICT (content): Merge conflict in ${p}\n`)
            } else putFile(sys, root, p, e)
            if (!repo.index.has(p) && s.index.has(p)) repo.index.set(p, s.index.get(p)!)
          }
          if (sub === 'pop') {
            repo.stash.shift()
            ctx.out(`Dropped refs/stash@{0} (${sha(s.msg)})\n`)
          }
          return 0
        }
        if (sub === 'drop') {
          repo.stash.shift()
          return 0
        }
        ctx.err(`error: unknown subcommand: ${sub}\n`)
        return 129
      }
      case 'tag': {
        const annotated = flag('-a')
        const msg = take('-m')
        const del = flag('-d')
        flag('-l', '--list')
        const p = pos()
        if (del) {
          for (const t of p) {
            const id = repo.refs.get(`refs/tags/${t}`)
            if (!id) {
              ctx.err(`error: tag '${t}' not found.\n`)
              return 1
            }
            repo.refs.delete(`refs/tags/${t}`)
            ctx.out(`Deleted tag '${t}' (was ${short(id)})\n`)
          }
          save()
          return 0
        }
        if (!p.length) {
          ctx.out([...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice(10)).sort().map((t) => t + '\n').join(''))
          return 0
        }
        if (repo.refs.has(`refs/tags/${p[0]}`)) {
          ctx.err(`fatal: tag '${p[0]}' already exists\n`)
          return 128
        }
        const id = resolveRev(repo, p[1] ?? 'HEAD')
        if (!id) {
          ctx.err(`fatal: Failed to resolve '${p[1] ?? 'HEAD'}' as a valid ref.\n`)
          return 128
        }
        if (annotated && !msg) {
          ctx.err('[simulador] Sin editor: usá git tag -a nombre -m "mensaje".\n')
          return 1
        }
        repo.refs.set(`refs/tags/${p[0]}`, id)
        if (msg) repo.tagMessages.set(p[0], msg)
        save()
        return 0
      }
      case 'remote': {
        const verbose = flag('-v', '--verbose')
        const sub = pos()[0]
        if (!sub) {
          for (const [n, u] of repo.remotes) ctx.out(verbose ? `${n}\t${u} (fetch)\n${n}\t${u} (push)\n` : `${n}\n`)
          return 0
        }
        const [, name, url] = pos()
        if (sub === 'add') {
          if (repo.remotes.has(name)) {
            ctx.err(`error: remote ${name} already exists.\n`)
            return 3
          }
          repo.remotes.set(name, url)
          return 0
        }
        if (sub === 'remove' || sub === 'rm') {
          repo.remotes.delete(name)
          for (const r of [...repo.refs.keys()]) if (r.startsWith(`refs/remotes/${name}/`)) repo.refs.delete(r)
          return 0
        }
        if (sub === 'set-url') {
          repo.remotes.set(name, url)
          return 0
        }
        if (sub === 'get-url') {
          const u = repo.remotes.get(name)
          if (!u) {
            ctx.err(`error: No such remote '${name}'\n`)
            return 2
          }
          ctx.out(u + '\n')
          return 0
        }
        ctx.err(`error: unknown subcommand: \`${sub}'\n`)
        return 129
      }
      case 'fetch':
      case 'pull': {
        flag('--prune', '-p', '--ff-only', '--no-rebase')
        const rebase = flag('--rebase')
        const name = pos()[0] ?? 'origin'
        const url = repo.remotes.get(name)
        if (!url) {
          ctx.err(`fatal: '${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`)
          return 128
        }
        const remote = openRemote(ctx, url)
        if (typeof remote === 'string') {
          ctx.err(remote + '\n')
          return 128
        }
        const src = remote.repo
        const tips = [...src.refs].filter(([r]) => r.startsWith('refs/heads/') || r.startsWith('refs/tags/')).map(([, id]) => id)
        const n = copyCommits(src, repo, tips)
        let fetchOut = ''
        for (const [r, id] of src.refs) {
          if (r.startsWith('refs/heads/')) {
            const local = `refs/remotes/${name}/${r.slice(11)}`
            const old = repo.refs.get(local)
            if (old !== id) fetchOut += `   ${old ? `${short(old)}..${short(id)}  ${r.slice(11).padEnd(10)} -> ${name}/${r.slice(11)}` : ` * [new branch]      ${r.slice(11).padEnd(10)} -> ${name}/${r.slice(11)}`}\n`
            repo.refs.set(local, id)
          } else if (r.startsWith('refs/tags/') && !repo.refs.has(r)) {
            repo.refs.set(r, id)
            fetchOut += ` * [new tag]           ${r.slice(10).padEnd(10)} -> ${r.slice(10)}\n`
          }
        }
        if (fetchOut) ctx.err(`${n ? `remote: Enumerating objects: ${n * 3}, done.\nUnpacking objects: 100% (${n * 3}/${n * 3}), done.\n` : ''}From ${url}\n${fetchOut}`)
        save()
        if (verb === 'fetch') return 0
        // pull = fetch + merge de la rama de seguimiento
        const br = branchName(repo)
        const up = repo.upstream.get(br) ?? `${name}/${br}`
        const theirs = repo.refs.get(`refs/remotes/${up}`)
        if (!theirs) {
          ctx.err(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\n`)
          return 1
        }
        const head = headCommit(repo)
        if (!head) {
          const c = repo.commits.get(theirs)!
          writeTree(sys, root, new Map(), c.tree)
          repo.index = new Map(c.tree)
          advanceHead(repo, theirs)
          save()
          return 0
        }
        if (ancestors(repo, head.id).has(theirs)) {
          ctx.out('Already up to date.\n')
          return 0
        }
        if (!ancestors(repo, theirs).has(head.id) && !rebase && !cfg(ctx, repo, 'pull.rebase') && !cfg(ctx, repo, 'pull.ff')) {
          ctx.err(`hint: You have divergent branches and need to specify how to reconcile them.\nhint: You can do so by running one of the following commands sometime before\nhint: your next pull:\nhint:\nhint:   git config pull.rebase false  # merge\nhint:   git config pull.rebase true   # rebase\nhint:   git config pull.ff only       # fast-forward only\nhint:\nfatal: Need to specify how to reconcile divergent branches.\n`)
          return 128
        }
        return await COMMANDS.get('git')!.run({ ...ctx, args: ['-C', root, 'merge', up] })
      }
      case 'push': {
        const setUp = flag('-u', '--set-upstream')
        const forced = flag('-f', '--force', '--force-with-lease')
        const tags = flag('--tags')
        flag('--all')
        const name = pos()[0] ?? 'origin'
        const br = pos()[1] ?? branchName(repo)
        const url = repo.remotes.get(name)
        if (!url) {
          ctx.err(`fatal: '${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`)
          return 128
        }
        if (!pos()[1] && !repo.upstream.has(br) && !setUp) {
          ctx.err(`fatal: The current branch ${br} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${name} ${br}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n\n`)
          return 128
        }
        const remote = openRemote(ctx, url)
        if (typeof remote === 'string') {
          ctx.err(remote + '\n')
          return 128
        }
        const dst = remote.repo
        let out = `To ${url}\n`
        if (tags) {
          for (const [r, id] of repo.refs) if (r.startsWith('refs/tags/') && !dst.refs.has(r)) {
            copyCommits(repo, dst, [id])
            dst.refs.set(r, id)
            out += ` * [new tag]         ${r.slice(10)} -> ${r.slice(10)}\n`
          }
          syncRefFiles(remote.sys, remote.path, dst)
          ctx.err(out)
          return 0
        }
        const [srcBr, dstBr] = br.includes(':') ? br.split(':') : [br, br]
        const local = resolveRev(repo, srcBr)
        if (!local) {
          ctx.err(`error: src refspec ${srcBr} does not match any\nerror: failed to push some refs to '${url}'\n`)
          return 1
        }
        const existing = dst.refs.get(`refs/heads/${dstBr}`)
        if (existing === local) {
          ctx.err('Everything up-to-date\n')
          return 0
        }
        if (existing && !ancestors(repo, local).has(existing) && !forced) {
          ctx.err(`${out} ! [rejected]        ${srcBr} -> ${dstBr} (${repo.commits.has(existing) ? 'non-fast-forward' : 'fetch first'})\nerror: failed to push some refs to '${url}'\nhint: Updates were rejected because the ${repo.commits.has(existing) ? 'tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use \'git pull\' before pushing again.' : "remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again."}\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n`)
          return 1
        }
        // pre-receive del servidor
        if (remote.sys.vfs.exists(`${gitDir(remote.path, dst.bare)}/hooks/pre-receive`, ROOT_CRED)) {
          const hook = `${gitDir(remote.path, dst.bare)}/hooks/pre-receive`
          if (remote.sys.vfs.stat(hook, ROOT_CRED).mode & 0o111) {
            const changed = history(repo, [local]).filter((c) => !existing || !ancestors(repo, existing).has(c.id))
            const text = changed.flatMap((c) => [...c.tree.values()].map((e) => e.data)).join('\n')
            const script = remote.sys.vfs.readFile(hook, ROOT_CRED)
            const pat = /grep -[a-zA-Z]*E?[a-zA-Z]* ['"]([^'"]+)['"]/.exec(script)?.[1]
            if (pat && new RegExp(pat, 'i').test(text)) {
              ctx.err(`remote: RECHAZADO: el push contiene algo que parece un secreto.\nTo ${url}\n ! [remote rejected] ${srcBr} -> ${dstBr} (pre-receive hook declined)\nerror: failed to push some refs to '${url}'\n`)
              return 1
            }
          }
        }
        const n = copyCommits(repo, dst, [local])
        dst.refs.set(`refs/heads/${dstBr}`, local)
        if (!dst.bare && dst.head === `refs/heads/${dstBr}`) {
          // Como git: no se deja actualizar la rama que está en uso en un repositorio con árbol.
          dst.refs.set(`refs/heads/${dstBr}`, existing ?? local)
          if (existing) {
            ctx.err(`remote: error: refusing to update checked out branch: refs/heads/${dstBr}\nTo ${url}\n ! [remote rejected] ${srcBr} -> ${dstBr} (branch is currently checked out)\nerror: failed to push some refs to '${url}'\n`)
            return 1
          }
        }
        syncRefFiles(remote.sys, remote.path, dst)
        repo.refs.set(`refs/remotes/${name}/${dstBr}`, local)
        if (setUp) repo.upstream.set(srcBr, `${name}/${dstBr}`)
        save()
        ctx.err(`${n ? `Enumerating objects: ${n * 3}, done.\nCounting objects: 100% (${n * 3}/${n * 3}), done.\nWriting objects: 100% (${n * 3}/${n * 3}), done.\nTotal ${n * 3} (delta 0), reused 0 (delta 0), pack-reused 0\n` : ''}${out}${existing ? `   ${forced ? '+ ' : ''}${short(existing)}${forced ? '...' : '..'}${short(local)}  ${srcBr} -> ${dstBr}${forced ? ' (forced update)' : ''}` : ` * [new branch]      ${srcBr} -> ${dstBr}`}\n${setUp ? `branch '${srcBr}' set up to track '${name}/${dstBr}'.\n` : ''}`)
        return 0
      }
      case 'rev-parse': {
        const abbrev = flag('--abbrev-ref')
        const shortF = flag('--short')
        if (flag('--show-toplevel')) {
          ctx.out(root + '\n')
          return 0
        }
        if (flag('--is-inside-work-tree')) {
          ctx.out('true\n')
          return 0
        }
        if (flag('--git-dir')) {
          ctx.out(gitDir(root, repo.bare) + '\n')
          return 0
        }
        const r = pos()[0] ?? 'HEAD'
        if (abbrev) {
          ctx.out((r === 'HEAD' ? (repo.detached ? 'HEAD' : branchName(repo)) : r) + '\n')
          return 0
        }
        const id = resolveRev(repo, r)
        if (!id) {
          ctx.err(`fatal: ambiguous argument '${r}': unknown revision or path not in the working tree.\n`)
          return 128
        }
        ctx.out((shortF ? short(id) : id) + '\n')
        return 0
      }
      case 'ls-files': {
        const others = flag('--others', '-o')
        flag('--exclude-standard')
        if (others) ctx.out(untrackedOf(sys, root, repo, workFiles(sys, root)).map((p) => p + '\n').join(''))
        else ctx.out([...repo.index.keys()].sort().map((p) => fromCwd(p) + '\n').join(''))
        return 0
      }
      case 'check-ignore': {
        const verbose = flag('-v')
        const rules = ignoreRules(sys, root)
        let any = false
        for (const p of pos()) {
          const r = rel(p)
          if (r !== undefined && isIgnored(rules, r, v.exists(`${root}/${r}`, ROOT_CRED) && v.stat(`${root}/${r}`, ROOT_CRED).type === 'dir')) {
            ctx.out(verbose ? `.gitignore\t${p}\n` : `${p}\n`)
            any = true
          }
        }
        return any ? 0 : 1
      }
      case 'blame': {
        const file = pos()[0]
        const r = rel(file ?? '')
        const head = headCommit(repo)
        if (!r || !head || !head.tree.has(r)) {
          ctx.err(`fatal: no such path '${file ?? ''}' in HEAD\n`)
          return 128
        }
        const cur = lines(head.tree.get(r)!.data)
        // Para cada línea, el commit más viejo que ya la tenía igual (siguiendo el primer padre).
        const chain: Commit[] = []
        for (let c: Commit | undefined = head; c; c = c.parents[0] ? repo.commits.get(c.parents[0]) : undefined) chain.push(c)
        const owner = cur.map(() => head)
        let tracked = cur.map((_l, i) => i)
        let prevLines = cur
        for (let k = 1; k < chain.length; k++) {
          const older = chain[k]
          const ol = lines(older.tree.get(r)?.data ?? '')
          const m = new Map(lcs(prevLines, ol))
          const next: number[] = []
          tracked.forEach((li, idx) => {
            const ix = m.get(idx)
            if (ix !== undefined) {
              owner[li] = older
              next[ix] = li
            }
          })
          tracked = []
          ol.forEach((_l, ix) => {
            if (next[ix] !== undefined) tracked.push(next[ix])
          })
          // reconstruir prevLines alineado con tracked
          const aligned: string[] = []
          const map2: number[] = []
          ol.forEach((l, ix) => {
            if (next[ix] !== undefined) {
              aligned.push(l)
              map2.push(next[ix])
            }
          })
          prevLines = aligned
          tracked = map2
          if (!aligned.length) break
        }
        ctx.out(cur.map((l, i) => `${short(owner[i].id)} (${owner[i].author.padEnd(12).slice(0, 12)} ${new Date(owner[i].time).toISOString().slice(0, 10)} ${String(i + 1).padStart(3)}) ${l}\n`).join(''))
        return 0
      }
      case 'clean': {
        const force = flag('-f', '--force')
        const dry = flag('-n', '--dry-run')
        flag('-d', '-fd', '-x')
        const untracked = untrackedOf(sys, root, repo, workFiles(sys, root))
        if (!force && !dry) {
          ctx.err('fatal: clean.requireForce is true and -f not given: refusing to clean\n')
          return 128
        }
        for (const p of untracked) {
          ctx.out(`${dry ? 'Would remove' : 'Removing'} ${p}\n`)
          if (!dry) v.unlink(`${root}/${p}`, ROOT_CRED)
        }
        return 0
      }
      case 'filter-repo': {
        const paths: string[] = []
        for (let p = take('--path'); p !== undefined; p = take('--path')) paths.push(p)
        const invert = flag('--invert-paths')
        const replace = take('--replace-text')
        const force = flag('--force')
        if (repo.remotes.size && !force && !repo.config.get('__filtered')) {
          ctx.err('Aborting: Refusing to destructively overwrite repo history since\nthis does not look like a fresh clone.\n  (expected freshly packed repo)\nPlease operate on a fresh clone instead.  If you want to proceed\nanyway, use --force.\n')
          return 1
        }
        const rules: [string, string][] = []
        if (replace) {
          const f = normalizePath(ctx.sh.resolve(replace))
          if (!v.exists(f, ROOT_CRED)) {
            ctx.err(`Error: ${replace}: No such file or directory\n`)
            return 1
          }
          for (const l of v.readFile(f, ROOT_CRED).split('\n')) {
            if (!l.trim()) continue
            const [a, b] = l.split('==>')
            rules.push([a, b ?? '***REMOVED***'])
          }
        }
        const map = new Map<string, string>()
        const order = history(repo, [...new Set(repo.refs.values())]).reverse()
        const newCommits = new Map<string, Commit>()
        for (const c of order) {
          const tree: Snapshot = new Map()
          for (const [p, e] of c.tree) {
            const hit = paths.some((x) => p === x || p.startsWith(x.replace(/\/$/, '') + '/'))
            if (paths.length && (invert ? hit : !hit)) continue
            let data = e.data
            for (const [a, b] of rules) data = data.split(a).join(b)
            tree.set(p, { data, mode: e.mode })
          }
          const nc: Commit = { ...c, id: sha(c.id + 'filtered'), tree, parents: c.parents.map((p) => map.get(p) ?? p) }
          map.set(c.id, nc.id)
          newCommits.set(nc.id, nc)
        }
        repo.commits = newCommits
        for (const [r, id] of [...repo.refs]) {
          if (r.startsWith('refs/remotes/')) repo.refs.delete(r)
          else repo.refs.set(r, map.get(id) ?? id)
        }
        repo.remotes.clear()
        repo.upstream.clear()
        repo.config.set('__filtered', '1')
        const h = headCommit(repo)
        if (h) {
          writeTree(sys, root, repo.index, h.tree)
          repo.index = new Map(h.tree)
        }
        save()
        ctx.out(`Parsed ${order.length} commits\nNew history written in 0.05 seconds; now repacking/cleaning...\nRepacking your repo and cleaning out old unneeded objects\nCompletely finished after 0.12 seconds.\n`)
        ctx.err('NOTICE: Removing \'origin\' remote; see \'Why is my origin removed?\'\n        in the manual if you want to push back there.\n        (was ' + '…' + ')\n')
        return 0
      }
      default:
        ctx.err(`git: '${verb}' is not a git command. See 'git --help'.\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// gitleaks: secretos en el historial o en lo que se va a commitear
// ---------------------------------------------------------------------------------------

const LEAK_RULES: { id: string; re: RegExp; desc: string }[] = [
  { id: 'generic-api-key', re: /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?([^\s'"#]{8,})/i, desc: 'Detected a Generic API Key, potentially exposing access to various services and sensitive operations.' },
  { id: 'aws-access-token', re: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/, desc: 'Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches.' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, desc: 'Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.' },
  { id: 'github-pat', re: /\b(ghp_[0-9a-zA-Z]{36})\b/, desc: 'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.' },
]

function scan(files: [string, string, Commit | undefined][]): { file: string; line: number; rule: string; secret: string; commit?: Commit; desc: string }[] {
  const out: ReturnType<typeof scan> = []
  for (const [file, data, commit] of files) {
    lines(data).forEach((l, i) => {
      for (const r of LEAK_RULES) {
        const m = r.re.exec(l)
        if (m) out.push({ file, line: i + 1, rule: r.id, secret: m[1] ?? m[0], commit, desc: r.desc })
      }
    })
  }
  return out
}

register('gitleaks', {
  usage: 'gitleaks detect [-v] [--no-git] [--source RUTA] | gitleaks protect --staged [-v]',
  path: '/usr/bin',
  run(ctx) {
    const a = ctx.args
    let mode = a[0]
    if (mode === 'detect') mode = a.includes('--no-git') ? 'dir' : 'git'
    if (mode === 'protect') mode = 'staged'
    if (mode === 'version' || a.includes('--version')) {
      ctx.out('8.18.2\n')
      return 0
    }
    const verbose = a.includes('-v') || a.includes('--verbose')
    const staged = mode === 'staged' || a.includes('--staged')
    const srcIdx = a.findIndex((x) => x === '--source' || x === '-s')
    const path = normalizePath(ctx.sh.resolve(srcIdx >= 0 ? a[srcIdx + 1] : a.filter((x, i) => i > 0 && !x.startsWith('-'))[0] ?? '.'))
    const banner = '\n    ○\n    │╲\n    │ ○\n    ○ ░\n    ░    gitleaks\n\n'
    let hits: ReturnType<typeof scan> = []
    if (mode === 'dir') {
      const files: [string, string, undefined][] = []
      const walk = (d: string) => {
        for (const n of ctx.sys.vfs.readdir(d, ROOT_CRED)) {
          if (n === '.git') continue
          const p = `${d === '/' ? '' : d}/${n}`
          const st = ctx.sys.vfs.stat(p, ROOT_CRED, false)
          if (st.type === 'dir') walk(p)
          else if (st.type === 'file') files.push([p, st.data, undefined])
        }
      }
      if (ctx.sys.vfs.exists(path, ROOT_CRED)) walk(path)
      hits = scan(files)
    } else {
      const found = findRepo(ctx.sys, path)
      if (!found) {
        ctx.err(`${banner}ERR fatal: not a git repository\n`)
        return 1
      }
      const { repo } = found
      if (staged) {
        const head = headCommit(repo)?.tree ?? new Map()
        hits = scan(diffSnapshots(head, repo.index).filter((p) => repo.index.has(p)).map((p) => [p, repo.index.get(p)!.data, undefined]))
      } else {
        const seen = new Set<string>()
        for (const c of history(repo, [...new Set(repo.refs.values())])) {
          const pt = c.parents[0] ? repo.commits.get(c.parents[0])?.tree ?? new Map() : new Map()
          for (const p of diffSnapshots(pt, c.tree)) {
            const e = c.tree.get(p)
            if (!e) continue
            const added = ops(lines(pt.get(p)?.data ?? ''), lines(e.data)).filter((o) => o.t === '+').map((o) => o.s)
            for (const h of scan([[p, added.join('\n'), c]])) {
              const key = `${h.file}:${h.secret}`
              if (!seen.has(key)) {
                seen.add(key)
                hits.push(h)
              }
            }
          }
        }
      }
    }
    let out = banner
    if (verbose)
      for (const h of hits)
        out += `Finding:     ${h.secret.length > 4 ? h.secret.slice(0, 4) + '***' : h.secret}\nSecret:      REDACTED\nRuleID:      ${h.rule}\nEntropy:     3.875000\nFile:        ${h.file}\nLine:        ${h.line}\n${h.commit ? `Commit:      ${h.commit.id}\nAuthor:      ${h.commit.author}\nEmail:       ${h.commit.email}\nDate:        ${new Date(h.commit.time).toISOString()}\n` : ''}Fingerprint: ${h.commit ? h.commit.id + ':' : ''}${h.file}:${h.rule}:${h.line}\n\n`
    out += `INF ${mode === 'dir' ? 'scanned ~' + hits.length * 120 + ' bytes' : `${staged ? 'staged changes scanned' : 'commits scanned'}`}\n`
    if (hits.length) {
      ctx.out(out)
      ctx.err(`WRN leaks found: ${hits.length}\n`)
      return 1
    }
    ctx.out(out + 'INF no leaks found\n')
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Estado inicial: repositorios con historia
// ---------------------------------------------------------------------------------------

System.initHooks.push((sys, state: BashState) => {
  for (const spec of state.git?.repos ?? []) {
    const repo = newRepo(spec.bare, spec.rama)
    repos(sys).set(spec.ruta, repo)
    sys.vfs.mkdirp(spec.ruta, ROOT_CRED)
    let tree: Snapshot = new Map()
    let t = Date.now() - spec.commits.length * 3_600_000 * 5
    let parent: string | undefined
    for (const c of spec.commits) {
      tree = new Map(tree)
      for (const [p, data] of Object.entries(c.archivos)) {
        if (data === null) tree.delete(p)
        else tree.set(p, { data, mode: /\.(sh|py)$/.test(p) ? 0o755 : 0o644 })
      }
      t += 3_600_000 * 5
      const commit: Commit = { id: sha(c.mensaje + t), tree, parents: parent ? [parent] : [], author: c.autor ?? 'Ana Gómez', email: c.correo ?? 'ana@ejemplo.test', time: t, message: c.mensaje }
      repo.commits.set(commit.id, commit)
      parent = commit.id
    }
    if (parent) repo.refs.set(`refs/heads/${spec.rama}`, parent)
    for (const [name, url] of Object.entries(spec.remotos)) repo.remotes.set(name, url)
    writeGitDir(sys, spec.ruta, repo)
    if (!spec.bare && parent) {
      writeTree(sys, spec.ruta, new Map(), tree)
      repo.index = new Map(tree)
    }
    for (const [p, data] of Object.entries(spec.cambios)) {
      if (data === null) {
        if (sys.vfs.exists(`${spec.ruta}/${p}`, ROOT_CRED)) sys.vfs.unlink(`${spec.ruta}/${p}`, ROOT_CRED)
      } else putFile(sys, spec.ruta, p, { data, mode: /\.(sh|py)$/.test(p) ? 0o755 : 0o644 })
    }
    if (spec.usuario) {
      const u = sys.users.get(spec.usuario)
      if (u) {
        const fix = (p: string) => {
          const st = sys.vfs.stat(p, ROOT_CRED, false)
          st.uid = u.uid
          st.gid = u.gid
          if (st.type === 'dir') for (const n of sys.vfs.readdir(p, ROOT_CRED)) fix(`${p}/${n}`)
        }
        fix(spec.ruta)
      }
    }
  }
})

// Los clones del estado inicial: copian la historia del repositorio de origen (que puede estar en otro equipo).
System.labHooks.push((all, states) => {
  states.forEach((st, i) => {
    for (const spec of st.git?.repos ?? []) {
      const origin = spec.remotos.origin
      if (!origin || spec.commits.length) continue
      const m = /^(?:([^@]+)@)?([^:]+):(.+)$/.exec(origin)
      const host = m ? all.find((s) => s.hostname === m[2] || s.ownIps().includes(m[2])) : all[i]
      const path = m ? m[3] : origin
      const src = host ? repos(host).get(normalizePath(path)) : undefined
      const repo = repos(all[i]).get(spec.ruta)
      if (!src || !repo) continue
      for (const [id, c] of src.commits) repo.commits.set(id, c)
      for (const [r, id] of src.refs) if (r.startsWith('refs/heads/')) repo.refs.set(`refs/remotes/origin/${r.slice(11)}`, id)
      const tip = src.refs.get(`refs/heads/${spec.rama}`)
      if (tip) {
        repo.refs.set(`refs/heads/${spec.rama}`, tip)
        repo.upstream.set(spec.rama, `origin/${spec.rama}`)
        const tree = repo.commits.get(tip)!.tree
        writeTree(all[i], spec.ruta, new Map(), tree)
        repo.index = new Map(tree)
      }
      syncRefFiles(all[i], spec.ruta, repo)
    }
  })
})

// ---------------------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------------------

export function verifyGit(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if (!('git_repo' in check)) return undefined
  const c = check as {
    git_repo: string
    existe?: boolean
    rama?: string
    ramas?: string[]
    commits_min?: number
    limpio?: boolean
    versionado?: string
    no_versionado?: string
    ultimo_mensaje?: string
    remoto?: string
    sincronizado?: boolean
    en_conflicto?: boolean
    etiqueta?: string
    historial_no_contiene?: string
    fusionada?: string
    hook?: string
  }
  const found = repos(sys).get(normalizePath(c.git_repo))
  const repo = found && sys.vfs.exists(`${gitDir(normalizePath(c.git_repo), found.bare)}/HEAD`, ROOT_CRED) ? found : undefined
  if (c.existe === false) return { ok: !repo, label: `no hay un repositorio en ${c.git_repo}` }
  let ok = !!repo
  const parts: string[] = []
  const root = normalizePath(c.git_repo)
  const head = repo ? headCommit(repo) : undefined
  if (ok && c.rama) {
    ok = !repo!.detached && branchName(repo!) === c.rama
    parts.push(`en la rama ${c.rama}`)
  }
  if (ok && c.ramas) {
    ok = c.ramas.every((b) => repo!.refs.has(`refs/heads/${b}`))
    parts.push(`con las ramas ${c.ramas.join(', ')}`)
  }
  if (ok && c.commits_min !== undefined) {
    ok = !!head && history(repo!, [head.id]).length >= c.commits_min
    parts.push(`con al menos ${c.commits_min} commit(s)`)
  }
  if (ok && c.limpio !== undefined) {
    const work = workFiles(sys, root)
    const clean = !!head && !diffSnapshots(head.tree, repo!.index).length && [...repo!.index.keys()].every((p) => sameEntry(repo!.index.get(p), work.get(p))) && !untrackedOf(sys, root, repo!, work).length && !repo!.merging
    ok = clean === c.limpio
    parts.push(c.limpio ? 'sin cambios pendientes' : 'con cambios pendientes')
  }
  if (ok && c.versionado) {
    ok = !!head?.tree.has(c.versionado)
    parts.push(`con ${c.versionado} versionado`)
  }
  if (ok && c.no_versionado) {
    ok = !head?.tree.has(c.no_versionado)
    parts.push(`sin ${c.no_versionado} versionado`)
  }
  if (ok && c.ultimo_mensaje) {
    ok = !!head && head.message.toLowerCase().includes(c.ultimo_mensaje.toLowerCase())
    parts.push(`con el último commit "${c.ultimo_mensaje}"`)
  }
  if (ok && c.remoto) {
    ok = repo!.remotes.has(c.remoto)
    parts.push(`con el remoto ${c.remoto}`)
  }
  if (ok && c.sincronizado) {
    const up = repo!.upstream.get(branchName(repo!))
    ok = !!up && repo!.refs.get(`refs/remotes/${up}`) === head?.id
    parts.push('al día con su remoto')
  }
  if (ok && c.en_conflicto !== undefined) {
    ok = !!repo!.merging === c.en_conflicto
    parts.push(c.en_conflicto ? 'en medio de una fusión' : 'sin fusión pendiente')
  }
  if (ok && c.etiqueta) {
    ok = repo!.refs.has(`refs/tags/${c.etiqueta}`)
    parts.push(`con la etiqueta ${c.etiqueta}`)
  }
  if (ok && c.fusionada) {
    const id = repo!.refs.get(`refs/heads/${c.fusionada}`)
    ok = !!id && !!head && ancestors(repo!, head.id).has(id)
    parts.push(`con ${c.fusionada} fusionada`)
  }
  if (ok && c.historial_no_contiene) {
    ok = ![...repo!.commits.values()].some((cm) => [...cm.tree.values()].some((e) => e.data.includes(c.historial_no_contiene!)))
    parts.push(`sin "${c.historial_no_contiene}" en ningún commit`)
  }
  if (ok && c.hook) {
    const p = `${gitDir(root, repo!.bare)}/hooks/${c.hook}`
    ok = sys.vfs.exists(p, ROOT_CRED) && !!(sys.vfs.stat(p, ROOT_CRED).mode & 0o111)
    parts.push(`con el hook ${c.hook} activo`)
  }
  return { ok, label: `hay un repositorio de Git en ${c.git_repo}${parts.length ? ' ' + parts.join(', ') : ''}` }
}
