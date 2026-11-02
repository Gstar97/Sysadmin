/**
 * Herramientas que usan los scripts: tar, gzip, mktemp, seq, bc, sha256sum y md5sum, cmp,
 * paste, timeout y flock.
 */
import { register, type CommandContext } from '../shell'
import { FsError, ROOT_CRED, type Inode } from '../vfs'
import { lines, readInputs } from './util'

// ---------------------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------------------

interface TarEntry {
  path: string
  type: 'file' | 'dir' | 'symlink'
  mode: number
  uid: number
  gid: number
  mtime: number
  data: string
}

const TAR_MAGIC = 'ustar\u0000SIM\n'
const GZ_MAGIC = '\u001f\u008b\u0008'

function packTar(entries: TarEntry[], gzip: boolean): string {
  const body = TAR_MAGIC + JSON.stringify(entries)
  return gzip ? GZ_MAGIC + body : body
}

function unpackTar(text: string): { entries: TarEntry[]; gzip: boolean } | undefined {
  const gzip = text.startsWith(GZ_MAGIC)
  const body = gzip ? text.slice(GZ_MAGIC.length) : text
  if (!body.startsWith(TAR_MAGIC)) return undefined
  try {
    return { entries: JSON.parse(body.slice(TAR_MAGIC.length)) as TarEntry[], gzip }
  } catch {
    return undefined
  }
}

function modeStr(e: TarEntry): string {
  const t = e.type === 'dir' ? 'd' : e.type === 'symlink' ? 'l' : '-'
  const r = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
  return t + r((e.mode >> 6) & 7) + r((e.mode >> 3) & 7) + r(e.mode & 7)
}

register('tar', {
  usage: 'tar -czf archivo.tar.gz carpeta...  |  tar -tzf archivo.tar.gz  |  tar -xzf archivo.tar.gz -C destino',
  summary: '  -c crear  -t listar  -x extraer  -z gzip  -f ARCHIVO  -v detalle  -C DIR (cambiar de carpeta)\n  --exclude=PATRÓN  (las rutas absolutas se guardan sin la / inicial)',
  run(ctx) {
    const args = [...ctx.args]
    // tar admite las letras sin guion: tar czf x.tgz dir
    if (args[0] && /^[ctxzjJvfpP]+$/.test(args[0])) args[0] = `-${args[0]}`
    let mode: 'c' | 't' | 'x' | undefined
    let gzip = false
    let verbose = false
    let file: string | undefined
    let dir: string | undefined
    const excludes: string[] = []
    const paths: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.startsWith('--exclude=')) excludes.push(a.slice(10))
      else if (a === '--exclude') excludes.push(args[++i] ?? '')
      else if (a === '-C' || a === '--directory') dir = args[++i]
      else if (a.startsWith('--file=')) file = a.slice(7)
      else if (a === '--gzip' || a === '-z') gzip = true
      else if (a === '--create') mode = 'c'
      else if (a === '--list') mode = 't'
      else if (a === '--extract') mode = 'x'
      else if (/^-[a-zA-Z]+$/.test(a)) {
        for (let k = 1; k < a.length; k++) {
          const c = a[k]
          if (c === 'c' || c === 't' || c === 'x') mode = c
          else if (c === 'z' || c === 'j' || c === 'J') gzip = true
          else if (c === 'v') verbose = true
          else if (c === 'f') {
            // f toma el siguiente argumento (o el resto de las letras)
            file = k + 1 < a.length ? a.slice(k + 1) : args[++i]
            break
          } else if (c === 'C') dir = args[++i]
        }
      } else paths.push(a)
    }
    if (!mode) {
      ctx.err("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.\n")
      return 2
    }
    const vfs = ctx.sys.vfs
    const cred = ctx.sh.cred
    const base = dir ? ctx.sh.resolve(dir) : ctx.sh.cwd
    if (mode === 'c') {
      if (!paths.length) {
        ctx.err('tar: Cowardly refusing to create an empty archive\nTry \'tar --help\' or \'tar --usage\' for more information.\n')
        return 2
      }
      const entries: TarEntry[] = []
      let failed = false
      let stripped = false
      const exclude = (p: string) => excludes.some((x) => new RegExp('(^|/)' + x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '(/|$)').test(p))
      const add = (abs: string, shown: string) => {
        if (exclude(shown)) return
        let node: Inode
        try {
          node = vfs.stat(abs, cred, false)
        } catch (e) {
          ctx.err(`tar: ${shown}: Cannot stat: ${e instanceof FsError ? e.message : 'error'}\n`)
          failed = true
          return
        }
        if (node.type === 'dir') {
          let names: string[]
          try {
            names = vfs.readdir(abs, cred)
          } catch {
            ctx.err(`tar: ${shown}: Cannot open: Permission denied\n`)
            failed = true
            return
          }
          entries.push({ path: shown.replace(/\/?$/, '/'), type: 'dir', mode: node.mode & 0o7777, uid: node.uid, gid: node.gid, mtime: node.mtime, data: '' })
          if (verbose) ctx.out(shown.replace(/\/?$/, '/') + '\n')
          for (const n of names.sort()) add(`${abs === '/' ? '' : abs}/${n}`, `${shown.replace(/\/$/, '')}/${n}`)
          return
        }
        let data: string
        if (node.type === 'file') {
          try {
            data = vfs.readFile(abs, cred)
          } catch {
            ctx.err(`tar: ${shown}: Cannot open: Permission denied\n`)
            failed = true
            return
          }
        } else data = node.data
        entries.push({ path: shown, type: node.type === 'symlink' ? 'symlink' : 'file', mode: node.mode & 0o7777, uid: node.uid, gid: node.gid, mtime: node.mtime, data })
        if (verbose) ctx.out(shown + '\n')
      }
      for (const p of paths) {
        const abs = p.startsWith('/') ? p : `${base}/${p}`.replace(/\/+/g, '/')
        let shown = p.replace(/\/+$/, '') || p
        if (shown.startsWith('/')) {
          shown = shown.replace(/^\/+/, '')
          if (!stripped) ctx.err("tar: Removing leading `/' from member names\n")
          stripped = true
        }
        add(abs.replace(/\/+$/, '') || '/', shown)
      }
      const archive = packTar(entries, gzip)
      if (!file || file === '-') ctx.out(archive)
      else {
        try {
          vfs.writeFile(ctx.sh.resolve(file), archive, cred, { mode: 0o644, umask: ctx.sh.umask })
        } catch (e) {
          ctx.err(`tar: ${file}: Cannot open: ${e instanceof FsError ? e.message : 'error'}\n`)
          ctx.err('tar: Error is not recoverable: exiting now\n')
          return 2
        }
      }
      if (failed) {
        ctx.err('tar: Exiting with failure status due to previous errors\n')
        return 2
      }
      return 0
    }
    // Listar o extraer
    let text: string
    try {
      text = !file || file === '-' ? ctx.stdin.readAll() : vfs.readFile(ctx.sh.resolve(file), cred)
    } catch (e) {
      ctx.err(`tar: ${file}: Cannot open: ${e instanceof FsError ? e.message : 'error'}\ntar: Error is not recoverable: exiting now\n`)
      return 2
    }
    const t = unpackTar(text)
    if (!t) {
      if (!text.length) ctx.err('tar: This does not look like a tar archive\n')
      else if (gzip && !text.startsWith(GZ_MAGIC)) ctx.err('\ngzip: stdin: not in gzip format\ntar: Child returned status 1\n')
      else ctx.err('tar: This does not look like a tar archive\ntar: Skipping to next header\n')
      ctx.err('tar: Exiting with failure status due to previous errors\n')
      return 2
    }
    const wanted = (p: string) => !paths.length || paths.some((x) => p === x || p.startsWith(x.replace(/\/?$/, '/')))
    if (mode === 't') {
      for (const e of t.entries.filter((x) => wanted(x.path))) {
        if (verbose) {
          const d = new Date(e.mtime)
          const pad = (n: number) => String(n).padStart(2, '0')
          ctx.out(`${modeStr(e)} ${ctx.sys.userName(e.uid)}/${ctx.sys.groupName(e.gid)} ${String(e.data.length).padStart(8)} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${e.path}\n`)
        } else ctx.out(e.path + '\n')
      }
      return 0
    }
    let failed = false
    for (const e of t.entries.filter((x) => wanted(x.path))) {
      const target = `${base === '/' ? '' : base}/${e.path}`.replace(/\/+$/, '')
      try {
        if (e.type === 'dir') {
          if (!vfs.exists(target)) vfs.mkdirp(target, cred, e.mode & 0o777)
        } else {
          const parent = target.slice(0, target.lastIndexOf('/')) || '/'
          if (!vfs.exists(parent)) vfs.mkdirp(parent, cred)
          if (e.type === 'symlink') {
            if (vfs.exists(target, cred, false)) vfs.unlink(target, cred)
            vfs.symlink(e.data, target, cred)
          } else vfs.writeFile(target, e.data, cred, { mode: e.mode & 0o777 })
        }
        const node = vfs.stat(target, ROOT_CRED, false)
        node.mode = (node.type === 'dir' ? node.mode & ~0o7777 : node.mode & ~0o7777) | (e.mode & 0o7777)
        node.mtime = e.mtime
        if (cred.uid === 0) {
          node.uid = e.uid
          node.gid = e.gid
        }
        if (verbose) ctx.out(e.path + '\n')
      } catch (err) {
        ctx.err(`tar: ${e.path}: Cannot open: ${err instanceof FsError ? err.message : 'error'}\n`)
        failed = true
      }
    }
    if (failed) {
      ctx.err('tar: Exiting with failure status due to previous errors\n')
      return 2
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// gzip, gunzip, zcat
// ---------------------------------------------------------------------------------------

register(['gzip', 'gunzip', 'zcat', 'zless'], {
  usage: 'gzip [-d] [-k] [-t] archivo...  |  gunzip archivo.gz  |  zcat archivo.gz',
  run(ctx) {
    const flags = ctx.args.filter((a) => a.startsWith('-')).join('')
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    const decompress = ctx.name !== 'gzip' || flags.includes('d')
    const keep = flags.includes('k') || flags.includes('c') || ctx.name === 'zcat'
    const test = flags.includes('t')
    const vfs = ctx.sys.vfs
    const cred = ctx.sh.cred
    if (!files.length) {
      const data = ctx.stdin.readAll()
      if (decompress) {
        if (!data.startsWith(GZ_MAGIC)) {
          ctx.err('gzip: stdin: not in gzip format\n')
          return 1
        }
        ctx.out(data.slice(GZ_MAGIC.length))
      } else ctx.out(GZ_MAGIC + data)
      return 0
    }
    let code = 0
    for (const f of files) {
      const abs = ctx.sh.resolve(f)
      let data: string
      try {
        data = vfs.readFile(abs, cred)
      } catch (e) {
        ctx.err(`${ctx.name}: ${f}: ${e instanceof FsError ? e.message : 'error'}\n`)
        code = 1
        continue
      }
      if (test) {
        if (!data.startsWith(GZ_MAGIC) && !f.endsWith('.gz')) {
          ctx.err(`gzip: ${f}: not in gzip format\n`)
          code = 1
        }
        continue
      }
      if (decompress) {
        // Los .gz que dejó logrotate en el simulador guardan el texto tal cual.
        if (!data.startsWith(GZ_MAGIC) && !f.endsWith('.gz')) {
          ctx.err(`gzip: ${f}: not in gzip format\n`)
          code = 1
          continue
        }
        const plain = data.startsWith(GZ_MAGIC) ? data.slice(GZ_MAGIC.length) : data
        if (ctx.name === 'zcat' || flags.includes('c')) {
          ctx.out(plain)
          continue
        }
        const target = abs.replace(/\.gz$/, '')
        vfs.writeFile(target, plain, cred, { mode: vfs.stat(abs, cred).mode & 0o777 })
        if (!keep) vfs.unlink(abs, cred)
      } else {
        if (f.endsWith('.gz')) {
          ctx.err(`gzip: ${f} already has .gz suffix -- unchanged\n`)
          code = 2
          continue
        }
        if (flags.includes('c')) {
          ctx.out(GZ_MAGIC + data)
          continue
        }
        vfs.writeFile(`${abs}.gz`, GZ_MAGIC + data, cred, { mode: vfs.stat(abs, cred).mode & 0o777 })
        if (!keep) vfs.unlink(abs, cred)
      }
    }
    return code
  },
})

// ---------------------------------------------------------------------------------------
// mktemp, seq, bc
// ---------------------------------------------------------------------------------------

register('mktemp', {
  usage: 'mktemp [-d] [-p DIR] [PLANTILLA.XXXXXX]',
  run(ctx) {
    const isDir = ctx.args.includes('-d')
    const pIdx = ctx.args.indexOf('-p')
    const dir = pIdx >= 0 ? ctx.args[pIdx + 1] : (ctx.sh.getVar('TMPDIR') ?? '/tmp')
    const tpl = ctx.args.filter((a, i) => !a.startsWith('-') && i !== pIdx + 1).pop() ?? 'tmp.XXXXXXXXXX'
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const name = tpl.replace(/X{3,}$/, (m) => Array.from({ length: m.length }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
    const path = name.startsWith('/') ? name : ctx.sh.resolve(`${dir}/${name}`)
    try {
      if (isDir) ctx.sys.vfs.mkdir(path, ctx.sh.cred, 0o700)
      else ctx.sys.vfs.writeFile(path, '', ctx.sh.cred, { mode: 0o600 })
    } catch (e) {
      ctx.err(`mktemp: failed to create ${isDir ? 'directory' : 'file'} via template '${path}': ${e instanceof FsError ? e.message : 'error'}\n`)
      return 1
    }
    ctx.out(path + '\n')
    return 0
  },
})

register('seq', {
  usage: 'seq [-w] [-s SEP] [PRIMERO [INCREMENTO]] ÚLTIMO',
  run(ctx) {
    const sIdx = ctx.args.indexOf('-s')
    const attached = ctx.args.find((a) => a.startsWith('-s') && a.length > 2)
    const sep = sIdx >= 0 ? ctx.args[sIdx + 1] : attached ? attached.slice(2) : '\n'
    const vals = ctx.args.filter((a, i) => (/^-?\d+(\.\d+)?$/.test(a) && ctx.args[i - 1] !== '-s')).map(Number)
    let first = 1
    let inc = 1
    let last: number
    if (vals.length === 1) last = vals[0]
    else if (vals.length === 2) [first, last] = vals
    else if (vals.length >= 3) [first, inc, last] = vals
    else {
      ctx.err("seq: missing operand\nTry 'seq --help' for more information.\n")
      return 1
    }
    const out: string[] = []
    const width = ctx.args.includes('-w') ? String(Math.max(Math.abs(first), Math.abs(last))).length : 0
    for (let n = first; inc > 0 ? n <= last : n >= last; n += inc) {
      out.push(width ? String(n).padStart(width, '0') : String(n))
      if (out.length > 100000) break
    }
    if (out.length) ctx.out(out.join(sep) + '\n')
    return 0
  },
})

register('bc', {
  usage: 'echo "scale=2; 10/3" | bc  (-l: con decimales)',
  run(ctx) {
    let scale = ctx.args.includes('-l') ? 20 : 0
    const input = ctx.stdin.readAll()
    for (const stmt of input.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
      const m = /^scale\s*=\s*(\d+)$/.exec(stmt)
      if (m) {
        scale = Number(m[1])
        continue
      }
      if (!/^[\d\s.+\-*/%()^]+$/.test(stmt)) {
        ctx.err(`(standard_in) 1: syntax error\n`)
        continue
      }
      try {
        const v = Function(`"use strict"; return (${stmt.replace(/\^/g, '**')})`)() as number
        const t = scale ? v.toFixed(scale).replace(/^(-?)0\./, '$1.') : String(Math.trunc(v))
        ctx.out(t + '\n')
      } catch {
        ctx.err('(standard_in) 1: syntax error\n')
      }
    }
    return 0
  },
})

register('cmp', {
  usage: 'cmp [-s] ARCHIVO1 ARCHIVO2',
  run(ctx) {
    const quiet = ctx.args.includes('-s')
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number' || inputs.length < 2) return 2
    const [a, b] = inputs
    if (a.data === b.data) return 0
    if (!quiet) {
      let k = 0
      while (k < Math.min(a.data.length, b.data.length) && a.data[k] === b.data[k]) k++
      const line = a.data.slice(0, k).split('\n').length
      if (k === Math.min(a.data.length, b.data.length)) ctx.err(`cmp: EOF on ${a.data.length < b.data.length ? a.name : b.name} after byte ${k}\n`)
      else ctx.out(`${a.name} ${b.name} differ: byte ${k + 1}, line ${line}\n`)
    }
    return 1
  },
})

register('paste', {
  usage: 'paste [-d SEP] [-s] ARCHIVO...',
  run(ctx) {
    const dIdx = ctx.args.indexOf('-d')
    const sep = dIdx >= 0 ? ctx.args[dIdx + 1] : ctx.args.find((a) => a.startsWith('-d'))?.slice(2) || '\t'
    const serial = ctx.args.includes('-s')
    const files = ctx.args.filter((a, i) => (a === '-' || !a.startsWith('-')) && i !== dIdx + 1)
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number') return 1
    const cols = inputs.map((i) => lines(i.data))
    if (serial) {
      for (const c of cols) ctx.out(c.join(sep[0] ?? '\t') + '\n')
      return 0
    }
    const n = Math.max(...cols.map((c) => c.length))
    for (let r = 0; r < n; r++) ctx.out(cols.map((c) => c[r] ?? '').join(sep[0] ?? '\t') + '\n')
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// timeout y flock: ejecutan otro comando
// ---------------------------------------------------------------------------------------

async function runInner(ctx: CommandContext, argv: string[]): Promise<number> {
  return ctx.sh.invoke(argv, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY })
}

register('timeout', {
  usage: 'timeout DURACIÓN comando [args]',
  async run(ctx) {
    const args = ctx.args.filter((a, i) => !a.startsWith('-') && ctx.args[i - 1] !== '-s' && ctx.args[i - 1] !== '-k')
    const [dur, ...cmd] = args
    if (!dur || !cmd.length) {
      ctx.err("timeout: missing operand\nTry 'timeout --help' for more information.\n")
      return 125
    }
    // Un comando que no termina solo (sleep largo, bucle) se corta y devuelve 124.
    if (cmd[0] === 'sleep' && Number(cmd[1] ?? 0) > parseFloat(dur)) return 124
    return runInner(ctx, cmd)
  },
})

const LOCKS = new Set<string>()

register('flock', {
  usage: 'flock [-n] ARCHIVO comando [args]',
  async run(ctx) {
    const noWait = ctx.args.includes('-n')
    const rest = ctx.args.filter((a) => !/^-[nxw]$/.test(a))
    const [file, ...cmd] = rest
    if (!file || !cmd.length) {
      ctx.err('flock: no command specified\n')
      return 64
    }
    const path = ctx.sh.resolve(file)
    if (!ctx.sys.vfs.exists(path)) ctx.sys.vfs.writeFile(path, '', ctx.sh.cred, { mode: 0o644 })
    const key = `${ctx.sys.hostname}:${path}`
    if (LOCKS.has(key)) {
      if (noWait) return 1
    }
    LOCKS.add(key)
    try {
      return await runInner(ctx, cmd[0] === '-c' ? ['bash', '-c', cmd.slice(1).join(' ')] : cmd)
    } finally {
      LOCKS.delete(key)
    }
  },
})

// ---------------------------------------------------------------------------------------
// openssl rand y chpasswd (contraseñas temporales en altas de usuarios)
// ---------------------------------------------------------------------------------------

register('openssl', {
  usage: 'openssl rand -base64 N  |  openssl rand -hex N  |  openssl version',
  run(ctx) {
    const [sub, ...rest] = ctx.args
    if (sub === 'version') {
      ctx.out(ctx.sys.distro === 'rocky' ? 'OpenSSL 3.2.2 4 Jun 2024 (Library: OpenSSL 3.2.2 4 Jun 2024)\n' : 'OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)\n')
      return 0
    }
    if (sub === 'rand') {
      const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? 0)
      const bytes = Array.from({ length: n }, () => Math.floor(Math.random() * 256))
      if (rest.includes('-hex')) ctx.out(bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '\n')
      else ctx.out(btoa(String.fromCharCode(...bytes)) + '\n')
      return 0
    }
    ctx.err(`[simulador] openssl ${sub ?? ''} no está simulado: solo rand y version. Los certificados se ven en el nivel 3.\n`)
    return 1
  },
})

register('chpasswd', {
  usage: 'echo "usuario:contraseña" | chpasswd',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('chpasswd: Permission denied.\nchpasswd: cannot lock /etc/shadow; try again later.\n')
      return 1
    }
    let code = 0
    let n = 0
    for (const line of lines(ctx.stdin.readAll())) {
      n++
      const [name, pass] = line.split(':')
      const u = ctx.sys.users.get(name)
      if (!u || pass === undefined) {
        ctx.err(`chpasswd: line ${n}: user '${name}' does not exist\nchpasswd: error detected, changes ignored\n`)
        code = 1
        continue
      }
      u.hasPassword = pass !== ''
      u.locked = false
      u.lastChange = Math.floor(Date.now() / 86_400_000)
    }
    ctx.sys.syncAccountFiles()
    return code
  },
})
