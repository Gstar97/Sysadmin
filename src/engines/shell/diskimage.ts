/**
 * Imágenes de disco de máquinas virtuales (qcow2, raw, vmdk, vhdx) y qemu-img.
 *
 * El archivo guarda una cabecera con la "firma" del formato y los datos de la imagen (tamaño
 * virtual, archivo base, instantáneas internas); el tamaño que ocupa en el disco es el tamaño
 * aparente del archivo. Así ls -lh muestra lo ocupado y qemu-img info, el tamaño virtual,
 * como pasa con una imagen dinámica de verdad.
 */
import { register, type CommandContext } from './shell'
import type { System } from './system'
import { normalizePath, ROOT_CRED, type Cred } from './vfs'

export type ImageFormat = 'qcow2' | 'raw' | 'vmdk' | 'vhdx' | 'vdi'

export interface ImageMeta {
  format: ImageFormat
  /** Tamaño que ve la máquina virtual (bytes). */
  virtual: number
  /** Archivo base (qcow2 con backing file). */
  backing?: string
  backingFmt?: ImageFormat
  /** Lo realmente escrito en el disco, si es distinto del tamaño del archivo (raw disperso, qcow2 con preallocation=metadata). */
  allocated?: number
  /** Instantáneas internas (qcow2). */
  snapshots?: { id: number; name: string; size: number; date: number; vmClock: string }[]
}

const MAGIC: Record<ImageFormat, string> = { qcow2: 'QFIû', raw: '\u0000\u0000RAW', vmdk: 'KDMV', vhdx: 'vhdxfile', vdi: '<<< Oracle VM VirtualBox Disk Image >>>' }

export const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** Lee los datos de una imagen (o undefined si el archivo no es una imagen simulada). */
export function readImage(sys: System, path: string, cred: Cred = ROOT_CRED): ImageMeta | undefined {
  if (!sys.vfs.exists(path, cred)) return undefined
  const data = sys.vfs.readFile(path, cred)
  for (const [fmt, magic] of Object.entries(MAGIC) as [ImageFormat, string][]) {
    if (!data.startsWith(magic)) continue
    try {
      const meta = JSON.parse(data.slice(magic.length).split('\n')[0]) as Omit<ImageMeta, 'format'>
      return { format: fmt, ...meta }
    } catch {
      return { format: fmt, virtual: 0 }
    }
  }
  return undefined
}

export function diskUsage(sys: System, path: string): number {
  if (!sys.vfs.exists(path)) return 0
  const n = sys.vfs.stat(path, ROOT_CRED)
  return n.size ?? n.data.length
}

/** Escribe (o reescribe) una imagen con lo que ocupa en el disco. */
export function writeImage(sys: System, path: string, meta: ImageMeta, used: number, cred: Cred = ROOT_CRED) {
  const { format, ...rest } = meta
  sys.vfs.writeFile(path, `${MAGIC[format]}${JSON.stringify(rest)}\n`, cred, { mode: 0o644 })
  sys.vfs.stat(path, ROOT_CRED).size = Math.round(used)
}

/** El ocupado de una imagen nueva: casi nada en las dinámicas, todo en raw. */
export function initialUsage(format: ImageFormat, virtual: number) {
  if (format === 'raw') return virtual
  if (format === 'qcow2') return 196 * 1024
  return 4 * MiB
}

/** "20G", "512M", "1.5T", "+5G" → bytes (el signo lo maneja quien llama). */
export function parseSize(s: string): number | undefined {
  const m = /^\+?(\d+(?:\.\d+)?)([KMGTP]?)(?:i?B)?$/i.exec(s.trim())
  if (!m) return undefined
  const mult: Record<string, number> = { '': 1, K: 1024, M: MiB, G: GiB, T: 1024 * GiB, P: 1024 * 1024 * GiB }
  return Math.round(Number(m[1]) * mult[m[2].toUpperCase()])
}

/** Como lo muestra qemu-img: "20 GiB", "1.2 GiB", "196 KiB". */
export function qsize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const txt = i === 0 ? String(v) : v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2).replace(/0$/, '').replace(/\.$/, '')
  return `${txt} ${units[i]}`
}

function abs(ctx: CommandContext, p: string) {
  return normalizePath(p.startsWith('/') ? p : `${ctx.sh.cwd}/${p}`)
}

function cred(ctx: CommandContext): Cred {
  return ctx.sh.cred
}

function infoText(sys: System, path: string, shown: string, meta: ImageMeta): string {
  const used = meta.allocated ?? diskUsage(sys, path)
  const length = diskUsage(sys, path)
  let out = `image: ${shown}\nfile format: ${meta.format}\nvirtual size: ${qsize(meta.virtual)} (${meta.virtual} bytes)\ndisk size: ${qsize(used)}\n`
  if (meta.format === 'qcow2') out += 'cluster_size: 65536\n'
  if (meta.backing) out += `backing file: ${meta.backing}\nbacking file format: ${meta.backingFmt ?? 'qcow2'}\n`
  if (meta.snapshots?.length) {
    out += 'Snapshot list:\nID        TAG               VM SIZE                DATE     VM CLOCK     ICOUNT\n'
    for (const s of meta.snapshots) out += `${String(s.id).padEnd(10)}${s.name.padEnd(18)}${qsize(s.size).padStart(7)} ${new Date(s.date).toISOString().replace('T', ' ').slice(0, 19)} ${s.vmClock}           --\n`
  }
  if (meta.format === 'qcow2') out += 'Format specific information:\n    compat: 1.1\n    compression type: zlib\n    lazy refcounts: false\n    refcount bits: 16\n    corrupt: false\n    extended l2: false\n'
  out += `Child node '/file':\n    filename: ${shown}\n    protocol type: file\n    file length: ${qsize(length)} (${length} bytes)\n    disk size: ${qsize(used)}\n`
  return out
}

const FORMATS: ImageFormat[] = ['qcow2', 'raw', 'vmdk', 'vhdx', 'vdi']

register('qemu-img', {
  usage: 'qemu-img info|create|convert|resize|check|snapshot ...',
  summary:
    '  info [--backing-chain] archivo\n  create -f qcow2 [-b base -F qcow2] archivo [tamaño]\n  convert [-p] [-f formato] -O formato entrada salida\n  resize [--shrink] archivo [+]tamaño\n  check archivo\n  snapshot -l|-c nombre|-a nombre|-d nombre archivo',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const [sub, ...rest] = ctx.args
    if (!sub || sub === '--help' || sub === '-h') {
      ctx.out('qemu-img version 8.2.2\nusage: qemu-img [standard options] command [command options]\n\nCommand syntax:\n  check, create, commit, compare, convert, info, map, measure, snapshot, rebase, resize, amend, bitmap, dd\n')
      return sub ? 0 : 1
    }
    if (sub === '--version' || sub === '-V') {
      ctx.out(`qemu-img version ${sys.distro === 'rocky' ? '9.1.0 (qemu-kvm-9.1.0-15.el10)' : '8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.4)'}\nCopyright (c) 2003-2024 Fabrice Bellard and the QEMU Project developers\n`)
      return 0
    }
    const opts = new Map<string, string>()
    const flags = new Set<string>()
    const pos: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if (['-f', '-O', '-b', '-F', '-o', '-l', '-c', '-a', '-d', '-s'].includes(a) && a !== '-l') {
        opts.set(a, rest[++i] ?? '')
      } else if (a.startsWith('--')) flags.add(a)
      else if (a === '-p' || a === '-q' || a === '-U' || a === '-l') flags.add(a)
      else pos.push(a)
    }
    const fail = (msg: string) => {
      ctx.err(`qemu-img: ${msg}\n`)
      return 1
    }
    const need = (p: string | undefined, what = 'Expecting one image file name') => {
      if (!p) {
        fail(what)
        return undefined
      }
      return abs(ctx, p)
    }
    try {
      switch (sub) {
        case 'info': {
          const file = need(pos[0])
          if (!file) return 1
          if (!sys.vfs.exists(file, cred(ctx))) return fail(`Could not open '${pos[0]}': Could not open '${pos[0]}': No such file or directory`)
          const meta = readImage(sys, file, cred(ctx))
          if (!meta) {
            const used = diskUsage(sys, file)
            ctx.out(`image: ${pos[0]}\nfile format: raw\nvirtual size: ${qsize(used)} (${used} bytes)\ndisk size: ${qsize(used)}\n`)
            return 0
          }
          ctx.out(infoText(sys, file, pos[0], meta))
          if (flags.has('--backing-chain')) {
            let b = meta.backing
            const seen = new Set<string>()
            while (b && !seen.has(b)) {
              seen.add(b)
              const bp = b.startsWith('/') ? b : normalizePath(`${file.replace(/\/[^/]+$/, '')}/${b}`)
              const bm = readImage(sys, bp)
              if (!bm) break
              ctx.out(`\n${infoText(sys, bp, b, bm)}`)
              b = bm.backing
            }
          }
          return 0
        }
        case 'create': {
          const fmt = (opts.get('-f') ?? 'raw') as ImageFormat
          if (!FORMATS.includes(fmt)) return fail(`Unknown file format '${fmt}'`)
          const file = need(pos[0])
          if (!file) return 1
          let backing = opts.get('-b')
          let backingFmt = opts.get('-F') as ImageFormat | undefined
          const o = opts.get('-o')
          if (o) {
            for (const kv of o.split(',')) {
              const [k, v] = kv.split('=')
              if (k === 'backing_file') backing = v
              if (k === 'backing_fmt') backingFmt = v as ImageFormat
            }
          }
          let size = pos[1] ? parseSize(pos[1]) : undefined
          if (pos[1] && size === undefined) return fail(`Invalid image size specified. You may use k, M, G, T, P or E suffixes for`)
          if (backing) {
            if (fmt !== 'qcow2') return fail(`Backing file not supported for file format '${fmt}'`)
            if (!backingFmt) return fail(`Backing file specified without backing format\nDetected format of ${backing}.`)
            const bp = backing.startsWith('/') ? backing : normalizePath(`${file.replace(/\/[^/]+$/, '')}/${backing}`)
            const bm = readImage(sys, bp)
            if (!bm) return fail(`Could not open backing file: Could not open '${backing}': No such file or directory`)
            if (size === undefined) size = bm.virtual
            if (size < bm.virtual) return fail(`Backing file's size is larger than the image's size`)
          }
          if (size === undefined) return fail('Image creation needs a size parameter')
          let prealloc = 'off'
          for (const kv of (o ?? '').split(',')) if (kv.startsWith('preallocation=')) prealloc = kv.split('=')[1]
          if (!['off', 'metadata', 'falloc', 'full'].includes(prealloc) || (fmt === 'raw' && prealloc === 'metadata')) return fail(`Invalid parameter '${prealloc}'`)
          // raw sin preasignar es un archivo disperso: mide todo, ocupa nada.
          const fileLen = fmt === 'raw' || prealloc !== 'off' ? size : initialUsage(fmt, size)
          const allocated = prealloc === 'full' || prealloc === 'falloc' ? size : fmt === 'raw' ? 0 : prealloc === 'metadata' ? 3.2 * MiB : undefined
          writeImage(sys, file, { format: fmt, virtual: size, backing, backingFmt, allocated }, fileLen, cred(ctx))
          const extra = fmt === 'qcow2' ? ` cluster_size=65536 extended_l2=off${prealloc !== 'off' ? ` preallocation=${prealloc}` : ''} compression_type=zlib size=${size}${backing ? ` backing_file=${backing} backing_fmt=${backingFmt}` : ''} lazy_refcounts=off refcount_bits=16` : `${prealloc !== 'off' ? ` preallocation=${prealloc}` : ''} size=${size}`
          ctx.out(`Formatting '${pos[0]}', fmt=${fmt}${extra}\n`)
          return 0
        }
        case 'convert': {
          const out = (opts.get('-O') ?? 'raw') as ImageFormat
          if (!FORMATS.includes(out)) return fail(`Unknown file format '${out}'`)
          if (pos.length < 2) return fail('Expecting image file name')
          const src = abs(ctx, pos[0])
          const dst = abs(ctx, pos[1])
          if (!sys.vfs.exists(src, cred(ctx))) return fail(`Could not open '${pos[0]}': Could not open '${pos[0]}': No such file or directory`)
          const meta = readImage(sys, src, cred(ctx)) ?? { format: 'raw' as ImageFormat, virtual: diskUsage(sys, src) }
          if (opts.get('-f') && opts.get('-f') !== meta.format) return fail(`Could not open '${pos[0]}': Image is not in ${opts.get('-f')} format`)
          // Lo ocupado: los datos reales de toda la cadena, sin las partes vacías (salvo en raw).
          let data = diskUsage(sys, src)
          let b = meta.backing
          while (b) {
            const bp = b.startsWith('/') ? b : normalizePath(`${src.replace(/\/[^/]+$/, '')}/${b}`)
            const bm = readImage(sys, bp)
            if (!bm) break
            data += diskUsage(sys, bp)
            b = bm.backing
          }
          if (meta.format === 'raw') data = Math.min(data, meta.virtual * 0.35)
          writeImage(sys, dst, { format: out, virtual: meta.virtual }, out === 'raw' ? meta.virtual : Math.min(meta.virtual, data), cred(ctx))
          if (flags.has('-p')) ctx.out('    (100.00/100%)\n')
          return 0
        }
        case 'resize': {
          const file = need(pos[0])
          if (!file) return 1
          const meta = readImage(sys, file, cred(ctx))
          if (!meta) return fail(`Could not open '${pos[0]}': No such file or directory`)
          const arg = pos[1] ?? ''
          const delta = parseSize(arg.replace(/^-/, ''))
          if (delta === undefined) return fail(`Invalid image size specified. Must be between 0 and 9223372036854775807.`)
          const newSize = arg.startsWith('+') ? meta.virtual + delta : arg.startsWith('-') ? meta.virtual - delta : delta
          if (newSize < meta.virtual && !flags.has('--shrink')) {
            ctx.err('qemu-img: Use the --shrink option to perform a shrink operation.\nqemu-img: warning: Shrinking an image will delete all data beyond the shrunken image\'s end. Before performing such an operation, make sure there is no important data there.\n')
            return 1
          }
          if (meta.snapshots?.length) return fail("Can't resize an image which has snapshots")
          writeImage(sys, file, { ...meta, virtual: newSize }, diskUsage(sys, file), cred(ctx))
          ctx.out('Image resized.\n')
          return 0
        }
        case 'check': {
          const file = need(pos[0])
          if (!file) return 1
          const meta = readImage(sys, file, cred(ctx))
          if (!meta) return fail(`Could not open '${pos[0]}': No such file or directory`)
          if (meta.format !== 'qcow2' && meta.format !== 'vdi' && meta.format !== 'vhdx') return fail(`This image format does not support checks`)
          const used = diskUsage(sys, file)
          ctx.out(`No errors were found on the image.\n${Math.max(1, Math.round(used / 65536))}/${Math.round(meta.virtual / 65536)} = ${((used / meta.virtual) * 100).toFixed(2)}% allocated, 0.00% fragmented, 0.00% compressed clusters\nImage end offset: ${used + 327680}\n`)
          return 0
        }
        case 'snapshot': {
          const file = need(pos[0])
          if (!file) return 1
          const meta = readImage(sys, file, cred(ctx))
          if (!meta) return fail(`Could not open '${pos[0]}': No such file or directory`)
          if (meta.format !== 'qcow2') return fail(`Could not ${flags.has('-l') ? 'list' : 'create'} snapshot: Operation not supported`)
          meta.snapshots ??= []
          if (flags.has('-l')) {
            if (!meta.snapshots.length) return 0
            ctx.out(`Snapshot list:\nID        TAG               VM SIZE                DATE     VM CLOCK     ICOUNT\n`)
            for (const s of meta.snapshots) ctx.out(`${String(s.id).padEnd(10)}${s.name.padEnd(18)}${qsize(s.size).padStart(7)} ${new Date(s.date).toISOString().replace('T', ' ').slice(0, 19)} ${s.vmClock}           --\n`)
            return 0
          }
          const c = opts.get('-c')
          const a = opts.get('-a')
          const d = opts.get('-d')
          if (c) meta.snapshots.push({ id: (meta.snapshots.at(-1)?.id ?? 0) + 1, name: c, size: 0, date: Date.now(), vmClock: '0000:00:00.000' })
          else if (a || d) {
            if (!meta.snapshots.some((s) => s.name === (a ?? d))) return fail(`Could not ${a ? 'apply' : 'delete'} snapshot '${a ?? d}': Can't find the snapshot`)
            if (d) meta.snapshots = meta.snapshots.filter((s) => s.name !== d)
          } else return fail('Expecting one of -l, -c, -a, -d')
          writeImage(sys, file, meta, diskUsage(sys, file), cred(ctx))
          return 0
        }
        default:
          return fail(`Command not found: ${sub}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/EACCES/.test(msg)) return fail(`Could not open '${pos[0]}': Permission denied`)
      if (/ENOENT/.test(msg)) return fail(`Could not create '${pos.at(-1)}': No such file or directory`)
      throw e
    }
  },
})
