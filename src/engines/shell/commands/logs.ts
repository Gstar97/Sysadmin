/**
 * logrotate (rotación de logs) y zcat. La rotación cambia archivos de verdad en el VFS:
 * renombra, crea el log nuevo, "comprime" (agrega .gz) y borra lo que sobra.
 */
import { parseArgs } from '../args'
import { parse } from '../parser'
import { register, Stdin, type CommandContext } from '../shell'
import { FsError, ROOT_CRED } from '../vfs'

type Freq = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'

interface LrOpts {
  freq?: Freq
  rotate: number
  size?: number
  minsize?: number
  maxsize?: number
  compress: boolean
  delaycompress: boolean
  missingok: boolean
  notifempty: boolean
  create?: { mode?: number; owner?: string; group?: string } | false
  copytruncate: boolean
  dateext: boolean
  su?: [string, string]
  sharedscripts: boolean
  prerotate?: string
  postrotate?: string
  maxage?: number
}

interface LrBlock {
  patterns: string[]
  opts: LrOpts
  file: string
}

const KEYWORDS = new Set([
  'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'rotate', 'size', 'minsize', 'maxsize', 'compress', 'nocompress', 'delaycompress', 'nodelaycompress',
  'missingok', 'nomissingok', 'notifempty', 'ifempty', 'create', 'nocreate', 'copytruncate', 'nocopytruncate', 'dateext', 'nodateext', 'dateformat',
  'su', 'sharedscripts', 'nosharedscripts', 'prerotate', 'postrotate', 'endscript', 'include', 'maxage', 'olddir', 'noolddir', 'compresscmd',
  'compressext', 'compressoptions', 'uncompresscmd', 'extension', 'tabooext', 'mail', 'nomail', 'start', 'shred', 'noshred', 'firstaction', 'lastaction',
  'dateyesterday', 'createolddir', 'nocreateolddir', 'copy', 'nocopy', 'renamecopy', 'allowcompressed',
])

function parseSize(v: string): number | undefined {
  const m = /^(\d+)([kKMG]?)$/.exec(v)
  if (!m) return undefined
  const mult = { '': 1, k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]!
  return Number(m[1]) * mult
}

interface Parsed {
  blocks: LrBlock[]
  errors: string[]
  /** Archivos leídos, en orden, para el modo -d. */
  read: string[]
}

function defaults(): LrOpts {
  return { rotate: 0, compress: false, delaycompress: false, missingok: false, notifempty: false, copytruncate: false, dateext: false, sharedscripts: false }
}

/** Lee la configuración (y los archivos incluidos) como logrotate. */
function parseConfig(ctx: CommandContext, path: string, globals: LrOpts, out: Parsed, top = true) {
  const vfs = ctx.sys.vfs
  if (!vfs.exists(path)) {
    out.errors.push(`error: cannot stat ${path}: No such file or directory`)
    return
  }
  const node = vfs.stat(path, ROOT_CRED)
  if (node.type === 'dir') {
    for (const f of vfs.readdir(path, ROOT_CRED).sort()) {
      if (/(~|\.rpmsave|\.rpmorig|\.rpmnew|\.dpkg-old|\.dpkg-dist|\.dpkg-new|\.bak|\.swp)$/.test(f) || f.startsWith('.')) continue
      parseConfig(ctx, `${path}/${f}`, globals, out, false)
    }
    return
  }
  const name = top ? path : path.split('/').pop()!
  if (node.uid !== 0) {
    out.errors.push(`error: Ignoring ${name} because the file owner is wrong (should be root or user with uid 0).`)
    return
  }
  if (node.mode & 0o022) {
    out.errors.push(`error: Ignoring ${name} because of bad file mode - must be 0644 or 0444.`)
    return
  }
  out.read.push(path)
  const lines = vfs.readFile(path, ROOT_CRED).split('\n')
  let block: LrBlock | undefined
  let pending: string[] = []
  let script: { key: 'prerotate' | 'postrotate'; lines: string[] } | undefined
  const target = () => (block ? block.opts : globals)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    const where = `${path}:${i + 1}`
    if (script) {
      if (line === 'endscript') {
        if (block) block.opts[script.key] = script.lines.join('\n')
        script = undefined
      } else script.lines.push(raw.replace(/^\s+/, ''))
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (line === '}') {
      if (!block) out.errors.push(`error: ${where} unexpected }`)
      else out.blocks.push(block)
      block = undefined
      continue
    }
    // Línea con rutas: puede terminar en "{" o el "{" puede venir en la línea siguiente.
    if (line.startsWith('/') || line.startsWith('"') || line === '{') {
      if (block) {
        out.errors.push(`error: ${where} unexpected log filename`)
        continue
      }
      const opens = line.endsWith('{')
      pending.push(...line.replace(/\{$/, '').split(/\s+/).filter(Boolean).map((p) => p.replace(/^"|"$/g, '')))
      if (opens) {
        block = { patterns: pending, opts: structuredClone(globals), file: path }
        pending = []
      }
      continue
    }
    if (pending.length) {
      out.errors.push(`error: ${where} missing '{' after log files definition`)
      pending = []
    }
    const [key, ...args] = line.split(/\s+/)
    if (!KEYWORDS.has(key)) {
      out.errors.push(`error: ${where} unknown option '${key}' -- ignoring line`)
      continue
    }
    const o = target()
    switch (key) {
      case 'hourly':
      case 'daily':
      case 'weekly':
      case 'monthly':
      case 'yearly':
        o.freq = key
        break
      case 'rotate': {
        const n = Number(args[0])
        if (!Number.isInteger(n)) out.errors.push(`error: ${where} bad rotation count '${args[0] ?? ''}'`)
        else o.rotate = n
        break
      }
      case 'size':
      case 'minsize':
      case 'maxsize': {
        const n = parseSize(args[0] ?? '')
        if (n === undefined) out.errors.push(`error: ${where} unknown unit '${args[0] ?? ''}'`)
        else o[key] = n
        break
      }
      case 'maxage':
        o.maxage = Number(args[0])
        break
      case 'compress':
      case 'delaycompress':
      case 'missingok':
      case 'notifempty':
      case 'copytruncate':
      case 'dateext':
      case 'sharedscripts':
        o[key] = true
        break
      case 'nocompress':
        o.compress = false
        break
      case 'nodelaycompress':
        o.delaycompress = false
        break
      case 'nomissingok':
        o.missingok = false
        break
      case 'ifempty':
        o.notifempty = false
        break
      case 'nocopytruncate':
        o.copytruncate = false
        break
      case 'nodateext':
        o.dateext = false
        break
      case 'nosharedscripts':
        o.sharedscripts = false
        break
      case 'create':
        o.create = args.length ? { mode: parseInt(args[0], 8), owner: args[1], group: args[2] } : {}
        break
      case 'nocreate':
        o.create = false
        break
      case 'su':
        if (args.length < 2) out.errors.push(`error: ${where} su directive requires user and group`)
        else o.su = [args[0], args[1]]
        break
      case 'prerotate':
      case 'postrotate':
        if (!block) out.errors.push(`error: ${where} ${key} outside of log file definition`)
        script = { key, lines: [] }
        break
      case 'endscript':
        out.errors.push(`error: ${where} endscript without matching prerotate or postrotate`)
        break
      case 'include':
        if (block) out.errors.push(`error: ${where} include directives are not allowed inside log file definitions`)
        else if (args[0]) parseConfig(ctx, args[0], globals, out, false)
        break
      default:
        break
    }
  }
  if (block || script) out.errors.push(`error: ${path}:${lines.length} missing '}' at end of file`)
}

const FREQ_MS: Record<Freq, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000, yearly: 365 * 86_400_000 }
const FREQ_TEXT: Record<Freq, string> = { hourly: 'after 1 hours', daily: 'after 1 days', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' }

const two = (n: number) => String(n).padStart(2, '0')
const dateStr = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function statePath(ctx: CommandContext) {
  return ctx.sys.distro === 'rocky' ? '/var/lib/logrotate/logrotate.status' : '/var/lib/logrotate/status'
}

async function runScript(ctx: CommandContext, script: string, arg: string): Promise<number> {
  const io = { stdin: new Stdin(), out: () => undefined, err: () => undefined, isTTY: false }
  try {
    return await ctx.sh.exec(parse(script.replace(/\$1/g, arg)), io)
  } catch {
    return 1
  }
}

register('logrotate', {
  usage: 'logrotate [-d] [-f] [-v] [-s statefile] configfile',
  path: '/usr/sbin',
  summary: '  -d, --debug     Muestra lo que haría, sin cambiar nada\n  -f, --force     Rota aunque no haga falta\n  -v, --verbose   Explica cada paso\n  -s, --state     Archivo de estado',
  async run(ctx) {
    const a = parseArgs(ctx.args, { flags: { d: ['d', 'debug'], f: ['f', 'force'], v: ['v', 'verbose'] }, values: { s: ['s', 'state'] } })
    if (!a.rest.length) {
      ctx.err('logrotate 3.22.0 - Copyright (C) 1995-2001 Red Hat, Inc.\nThis may be freely redistributed under the terms of the GNU General Public License\n\nUsage: logrotate [-dfv?] [-d|--debug] [-f|--force] [-s|--state=statefile] <configfile>\n')
      return 1
    }
    const debug = a.flags.has('d')
    const verbose = debug || a.flags.has('v')
    const force = a.flags.has('f')
    const state = a.values.get('s') ?? statePath(ctx)
    const say = (s: string) => {
      if (verbose) ctx.out(s + '\n')
    }
    if (ctx.sh.user !== 'root' && !debug) {
      ctx.err(`error: error creating output file ${state}.tmp: Permission denied\n`)
      return 1
    }
    if (debug) ctx.err('warning: logrotate in debug mode does nothing except printing debug messages!  Consider using verbose mode (-v) instead if this is not what you want.\n\n')
    const parsed: Parsed = { blocks: [], errors: [], read: [] }
    const globals = defaults()
    for (const f of a.rest) parseConfig(ctx, ctx.sh.resolve(f), globals, parsed)
    for (const f of parsed.read) say(`reading config file ${f}`)
    for (const e of parsed.errors) ctx.err(e + '\n')
    let code = parsed.errors.length ? 1 : 0
    say(`Reading state from file: ${state}`)
    say(`\nHandling ${parsed.blocks.length} logs\n`)
    const vfs = ctx.sys.vfs
    const now = Date.now()
    for (const b of parsed.blocks) {
      const o = b.opts
      const when = force ? 'forced from command line' : o.size !== undefined ? `${o.size} bytes` : o.freq ? FREQ_TEXT[o.freq] : 'after 1 days'
      say(`rotating pattern: ${b.patterns.join(' ')}  ${when} (${o.rotate} rotations)`)
      say(`${o.notifempty ? 'empty log files are not rotated' : 'empty log files are rotated'}, ${o.maxage ? `old logs are removed after ${o.maxage} days` : 'old logs are removed'}`)
      const files: string[] = []
      for (const p of b.patterns) {
        const matches = /[*?[]/.test(p) ? ctx.sh.glob(p) : vfs.exists(p) ? [p] : []
        if (!matches.length && !o.missingok) {
          ctx.err(`error: stat of ${p} failed: No such file or directory\n`)
          code = 1
        }
        files.push(...matches.filter((m) => !/\.(\d+|gz)$|-\d{8}(\.gz)?$/.test(m)))
      }
      const rotated: string[] = []
      if (o.sharedscripts && o.prerotate && files.length) {
        say('running prerotate script')
        if (!debug && (await runScript(ctx, o.prerotate, b.patterns.join(' '))) !== 0) ctx.err(`error: error running shared prerotate script for '${b.patterns.join(' ')} '\n`)
      }
      for (const f of files) {
        say(`considering log ${f}`)
        const node = vfs.stat(f, ROOT_CRED)
        const size = node.size ?? node.data.length
        const last = ctx.sys.logrotateState.get(f)
        say(`  Now: ${dateStr(now)}`)
        say(`  Last rotated at ${dateStr(last ?? now)}`)
        // Carpeta insegura: escribible por otros (o por un grupo que no es root) y sin "su".
        const dir = f.slice(0, f.lastIndexOf('/')) || '/'
        const dnode = vfs.stat(dir, ROOT_CRED)
        if (!o.su && (dnode.mode & 0o002 || (dnode.mode & 0o020 && dnode.gid !== 0))) {
          ctx.err(
            `error: skipping "${f}" because parent directory has insecure permissions (It's world writable or writable by group which is not "root") Set "su" directive in config file to tell logrotate which user/group should be used for rotation.\n`,
          )
          code = 1
          continue
        }
        if (o.notifempty && size === 0) {
          say('  log does not need rotating (log is empty)')
          continue
        }
        let needs = force
        if (!needs && o.size !== undefined) needs = size > o.size
        else if (!needs && last === undefined) {
          // Primera vez que logrotate ve el archivo: anota la fecha y espera al próximo período.
          if (!debug) ctx.sys.logrotateState.set(f, now)
          say(`  log does not need rotating (log has been already rotated)`)
          continue
        } else if (!needs) needs = now - last! >= FREQ_MS[o.freq ?? 'daily']
        if (!needs) {
          say(`  log does not need rotating (log has been rotated at ${dateStr(last!)}, which is less than ${o.freq === 'weekly' ? 'a week' : o.freq === 'monthly' ? 'a month' : o.freq === 'yearly' ? 'a year' : o.freq === 'hourly' ? 'an hour' : 'a day'} ago)`)
          continue
        }
        say('  log needs rotating')
        rotated.push(f)
        if (!o.sharedscripts && o.prerotate && !debug) await runScript(ctx, o.prerotate, f)
        const ext = o.compress ? '.gz' : ''
        try {
          if (o.dateext) {
            const d = new Date(now)
            const suffix = `-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`
            say(`dateext suffix '${suffix}'`)
            const dest = `${f}${suffix}`
            if (vfs.exists(dest) || vfs.exists(dest + '.gz')) {
              ctx.err(`error: destination ${dest} already exists, skipping rotation\n`)
              code = 1
              continue
            }
            say(`renaming ${f} to ${dest}`)
            if (!debug) {
              if (o.copytruncate) {
                vfs.copy(f, dest, ROOT_CRED, { preserve: true })
                vfs.writeFile(f, '', ROOT_CRED)
              } else vfs.rename(f, dest, ROOT_CRED)
              if (o.compress && !o.delaycompress) vfs.rename(dest, dest + '.gz', ROOT_CRED)
            }
            // Quedan solo las "rotate" copias más nuevas.
            const base = f.split('/').pop()!
            const old = vfs
              .readdir(dir, ROOT_CRED)
              .filter((n) => n.startsWith(base + '-') && /-\d{8}(\.gz)?$/.test(n))
              .sort()
            const extra = old.length - o.rotate
            for (const n of old.slice(0, Math.max(0, extra))) {
              say(`removing old log ${dir}/${n}`)
              if (!debug) vfs.unlink(`${dir}/${n}`, ROOT_CRED)
            }
          } else {
            const nameOf = (i: number) => {
              for (const cand of [`${f}.${i}`, `${f}.${i}.gz`]) if (vfs.exists(cand)) return cand
              return undefined
            }
            const drop = o.rotate > 0 ? nameOf(o.rotate) : undefined
            if (drop) {
              say(`removing old log ${drop}`)
              if (!debug) vfs.unlink(drop, ROOT_CRED)
            }
            for (let i = o.rotate - 1; i >= 1; i--) {
              const cur = nameOf(i)
              if (!cur) continue
              const to = cur.replace(new RegExp(`\\.${i}(\\.gz)?$`), `.${i + 1}$1`)
              say(`renaming ${cur} to ${to} (rotatecount ${o.rotate}, logstart 1, i ${i}),`)
              if (!debug) vfs.rename(cur, to, ROOT_CRED)
            }
            if (o.rotate === 0) {
              say(`log ${f} will be removed (rotate 0)`)
              if (!debug) vfs.unlink(f, ROOT_CRED)
            } else {
              say(`renaming ${f} to ${f}.1`)
              if (!debug) {
                if (o.copytruncate) {
                  say(`copying ${f} to ${f}.1`)
                  vfs.copy(f, `${f}.1`, ROOT_CRED, { preserve: true })
                  say(`truncating ${f}`)
                  vfs.writeFile(f, '', ROOT_CRED)
                } else vfs.rename(f, `${f}.1`, ROOT_CRED)
              }
              if (o.compress) {
                const which = o.delaycompress ? `${f}.2` : `${f}.1`
                if (o.delaycompress ? vfs.exists(which) : true) {
                  say(`compressing log with: /bin/gzip`)
                  if (!debug && vfs.exists(which)) vfs.rename(which, which + ext, ROOT_CRED)
                }
              }
            }
          }
          // Archivo nuevo y vacío, con el modo y dueño de "create" (o los del original).
          if (o.create !== false && !o.copytruncate && o.rotate !== 0) {
            const c = o.create ?? {}
            const mode = c.mode ?? node.mode
            const uid = c.owner ? (ctx.sys.users.get(c.owner)?.uid ?? node.uid) : node.uid
            const gid = c.group ? (ctx.sys.groups.get(c.group)?.gid ?? node.gid) : node.gid
            say(`creating new ${f} mode = 0${(mode & 0o7777).toString(8)} uid = ${uid} gid = ${gid}`)
            if (!debug) {
              vfs.writeFile(f, '', ROOT_CRED)
              const nn = vfs.stat(f, ROOT_CRED)
              nn.mode = mode
              nn.uid = uid
              nn.gid = gid
            }
          }
          if (!debug) ctx.sys.logrotateState.set(f, now)
        } catch (e) {
          if (!(e instanceof FsError)) throw e
          ctx.err(`error: error renaming ${f}: ${e.code === 'EACCES' ? 'Permission denied' : 'No such file or directory'}\n`)
          code = 1
        }
        if (!o.sharedscripts && o.postrotate) {
          say('running postrotate script')
          if (!debug && (await runScript(ctx, o.postrotate, f)) !== 0) {
            ctx.err(`error: error running non-shared postrotate script for ${f} of '${b.patterns.join(' ')} '\n`)
            code = 1
          }
        }
      }
      if (o.sharedscripts && o.postrotate && rotated.length) {
        say('running postrotate script')
        if (!debug && (await runScript(ctx, o.postrotate, b.patterns.join(' '))) !== 0) {
          ctx.err(`error: error running shared postrotate script for '${b.patterns.join(' ')} '\n`)
          code = 1
        }
      }
    }
    if (!debug && ctx.sh.user === 'root') {
      const lines = ['logrotate state -- version 2']
      for (const [f, t] of ctx.sys.logrotateState) {
        const d = new Date(t)
        lines.push(`"${f}" ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`)
      }
      vfs.mkdirp(state.slice(0, state.lastIndexOf('/')), ROOT_CRED)
      vfs.writeFile(state, lines.join('\n') + '\n', ROOT_CRED)
    }
    return code
  },
})

register(['zcat', 'zless'], {
  usage: 'zcat [FILE]...',
  run(ctx) {
    let code = 0
    for (const f of ctx.args.filter((x) => !x.startsWith('-'))) {
      const path = ctx.sh.resolve(f)
      try {
        if (!path.endsWith('.gz')) {
          ctx.err(`gzip: ${f}: not in gzip format\n`)
          code = 1
          continue
        }
        ctx.out(ctx.sys.vfs.readFile(path, ctx.sh.cred))
      } catch {
        ctx.err(`gzip: ${f}: No such file or directory\n`)
        code = 1
      }
    }
    return code
  },
})
