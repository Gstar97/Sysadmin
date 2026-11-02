/**
 * Comandos de almacenamiento: lsblk, blkid, fdisk, parted, mkfs, mount, umount, findmnt, df,
 * swap, LVM (pv*, vg*, lv*), xfs_growfs, resize2fs, fallocate, dd y lsof.
 */
import { parseArgs } from '../args'
import { register, type CommandContext } from '../shell'
import { dmName, EXTENT, GiB, MBR_TYPES, MiB, parseSize, SECTOR, VIRTUAL_MOUNTS, type Disk, type FsSig, type FsType, type MountEntry, type PartEntry, type Storage, type VG } from '../storage'
import { normalizePath, ROOT_CRED } from '../vfs'
import { askYes } from './files'

const st = (ctx: CommandContext): Storage => ctx.sys.storage

function needRoot(ctx: CommandContext, msg: string): boolean {
  if (ctx.sh.user === 'root') return false
  ctx.err(msg)
  return true
}

/** Tamaño como lo muestra lsblk: un decimal, sin ".0". */
function lsSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r : r.toFixed(1)}${units[i]}`
}

/** Tamaño como lo muestra LVM: 2.00g, <18.41g, 512.00m. */
function lvmSize(bytes: number): string {
  if (bytes === 0) return '0 '
  const unit = bytes >= GiB ? GiB : MiB
  const suffix = bytes >= GiB ? 'g' : 'm'
  const v = bytes / unit
  const r = Math.round(v * 100) / 100
  // Como LVM: si el número mostrado es mayor que el real, se antepone "<".
  return `${r > v + 1e-9 ? '<' : ''}${r.toFixed(2)}${suffix}`
}

function lvmLong(bytes: number): string {
  return bytes >= GiB ? `${(bytes / GiB).toFixed(2)} GiB` : `${(bytes / MiB).toFixed(2)} MiB`
}

/** Unidades de parted (decimales): 1049kB, 5369MB, 10.7GB. */
function partedSize(bytes: number): string {
  if (bytes < 1e4) return `${bytes}B`
  if (bytes < 1e7) return `${Math.round(bytes / 1e3)}kB`
  if (bytes < 1e10) return `${Math.round(bytes / 1e6)}MB`
  return `${(bytes / 1e9).toPrecision(3)}GB`
}

/** df -h: redondea hacia arriba, un decimal por debajo de 10. */
function dfHuman(bytes: number, si: boolean): string {
  const base = si ? 1000 : 1024
  if (bytes === 0) return '0'
  const units = ['', 'K', 'M', 'G', 'T']
  let v = bytes
  let i = 0
  while (v >= base && i < units.length - 1) {
    v /= base
    i++
  }
  return `${v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : Math.ceil(v)}${units[i]}`
}

function devName(path: string): string {
  return path.replace(/^\/dev\//, '')
}

const FSVER: Record<FsType, string> = { xfs: '', ext4: '1.0', vfat: 'FAT32', swap: '1', LVM2_member: 'LVM2 001' }

// ---------------------------------------------------------------------------------------
// lsblk y blkid
// ---------------------------------------------------------------------------------------

interface Row {
  name: string
  path: string
  majmin: string
  size: number
  type: 'disk' | 'part' | 'lvm' | 'rom'
  depth: number
  last: boolean[]
}

/** LV que tienen espacio en un PV (se reparte en orden entre los PV del VG). */
function lvsOnPv(s: Storage, pv: string): { vg: VG; lv: { name: string; size: number; minor: number } }[] {
  const vg = s.vgOf(pv)
  if (!vg) return []
  const caps = vg.pvs.map((p) => s.pvExtents(p) * EXTENT)
  const out: ReturnType<typeof lvsOnPv> = []
  let pvIndex = 0
  let usedOnPv = 0
  for (const lv of vg.lvs) {
    let need = lv.size
    while (need > 0 && pvIndex < vg.pvs.length) {
      const free = caps[pvIndex] - usedOnPv
      const take = Math.min(free, need)
      if (take > 0 && vg.pvs[pvIndex] === pv && !out.some((o) => o.lv === lv)) out.push({ vg, lv })
      need -= take
      usedOnPv += take
      if (usedOnPv >= caps[pvIndex]) {
        pvIndex++
        usedOnPv = 0
      }
    }
  }
  return out
}

function blockRows(s: Storage, only?: string[]): Row[] {
  const rows: Row[] = []
  const disks = [...s.disks.values()].sort((a, b) => a.name.localeCompare(b.name))
  const addLvs = (pv: string, depth: number, last: boolean[]) => {
    const lvs = lvsOnPv(s, pv)
    lvs.forEach((x, i) => rows.push({ name: dmName(x.vg.name, x.lv.name), path: s.lvPath(x.vg.name, x.lv.name), majmin: `253:${x.lv.minor}`, size: x.lv.size, type: 'lvm', depth, last: [...last, i === lvs.length - 1] }))
  }
  for (const d of disks) {
    if (only?.length && !only.includes(`/dev/${d.name}`)) continue
    rows.push({ name: d.name, path: `/dev/${d.name}`, majmin: `${d.major}:${d.minor}`, size: d.size, type: 'disk', depth: 0, last: [] })
    if (!d.parts.length) addLvs(`/dev/${d.name}`, 1, [])
    d.parts.forEach((p, i) => {
      const path = s.partPath(d.name, p.num)
      const last = i === d.parts.length - 1
      rows.push({ name: devName(path), path, majmin: `${d.major}:${d.minor + p.num}`, size: (p.end - p.start + 1) * SECTOR, type: 'part', depth: 1, last: [last] })
      addLvs(path, 2, [last])
    })
  }
  if (!only?.length) rows.push({ name: 'sr0', path: '/dev/sr0', majmin: '11:0', size: 1073741312, type: 'rom', depth: 0, last: [] })
  return rows
}

function treeName(r: Row, full: boolean): string {
  let prefix = ''
  for (let i = 0; i < r.depth; i++) {
    const isLast = r.last[i]
    if (i === r.depth - 1) prefix += isLast ? '└─' : '├─'
    else prefix += isLast ? '  ' : '│ '
  }
  return prefix + (full ? r.path : r.name)
}

function mountpointOf(s: Storage, path: string): string {
  if (s.swaps.some((w) => w.path === path)) return '[SWAP]'
  return s.mounts.find((m) => m.dev === path)?.target ?? ''
}

register('lsblk', {
  usage: 'lsblk [options] [device...]',
  summary: '  -f, --fs   sistemas de archivos y UUID\n  -o LISTA   columnas (NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,UUID...)\n  -p         rutas completas\n  -d         solo discos',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { f: ['f', 'fs'], p: ['p', 'paths'], d: ['d', 'nodeps'], n: ['n', 'noheadings'] }, values: { o: ['o', 'output'] } })
    const s = st(ctx)
    const only = a.rest.map((x) => s.canonical(x) ?? x)
    for (const x of only) {
      if (s.size(x) === undefined) {
        ctx.err(`lsblk: ${x}: not a block device\n`)
        return 32
      }
    }
    let rows = blockRows(s, only.filter((x) => /^\/dev\/[a-z]+$/.test(x)))
    if (only.some((x) => !/^\/dev\/[a-z]+$/.test(x))) rows = rows.filter((r) => only.includes(r.path)).map((r) => ({ ...r, depth: 0, last: [] }))
    if (a.flags.has('d')) rows = rows.filter((r) => r.depth === 0)
    const cols = a.values.has('o') ? a.values.get('o')!.toUpperCase().split(',') : a.flags.has('f') ? ['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS'] : ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINTS']
    const val = (r: Row, c: string): string => {
      const sig = s.sigs.get(r.path)
      const mp = mountpointOf(s, r.path)
      const m = s.mounts.find((x) => x.dev === r.path)
      switch (c) {
        case 'NAME':
          return treeName(r, a.flags.has('p'))
        case 'KNAME':
        case 'PATH':
          return c === 'PATH' ? r.path : r.name
        case 'MAJ:MIN':
          return r.majmin
        case 'RM':
          return r.type === 'rom' ? '1' : '0'
        case 'RO':
          return '0'
        case 'SIZE':
          return lsSize(r.size).padStart(5)
        case 'TYPE':
          return r.type
        case 'MOUNTPOINT':
        case 'MOUNTPOINTS':
          return mp
        case 'FSTYPE':
          return sig?.type ?? ''
        case 'FSVER':
          return sig ? FSVER[sig.type] : ''
        case 'LABEL':
          return sig?.label ?? ''
        case 'UUID':
          return sig?.uuid ?? ''
        case 'FSAVAIL':
          return m && sig ? lsSize(Math.max(0, sig.size - s.used(r.path))) : ''
        case 'FSUSE%':
          return m && sig ? `${Math.round((s.used(r.path) / sig.size) * 100)}%` : ''
        case 'FSSIZE':
          return m && sig ? lsSize(sig.size) : ''
        case 'MODEL':
          return r.type === 'disk' ? (s.disks.get(r.name)?.model ?? '') : r.type === 'rom' ? 'QEMU DVD-ROM' : ''
        default:
          return ''
      }
    }
    const table = rows.map((r) => cols.map((c) => val(r, c)))
    const widths = cols.map((c, i) => Math.max(c.length, ...table.map((t) => t[i].length)))
    const right = new Set(['MAJ:MIN', 'SIZE', 'FSAVAIL', 'FSUSE%', 'FSSIZE', 'RM', 'RO'])
    const line = (cells: string[]) => cells.map((v, i) => (i === cells.length - 1 ? v : right.has(cols[i]) ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' ').trimEnd()
    if (!a.flags.has('n')) ctx.out(line(cols) + '\n')
    for (const t of table) ctx.out(line(t) + '\n')
    return 0
  },
})

register('blkid', {
  usage: 'blkid [-s TAG] [-o value] [device...]',
  path: '/usr/sbin',
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { s: ['s', 'match-tag'], o: ['o', 'output'] } })
    const s = st(ctx)
    const devs = a.rest.length ? a.rest.map((x) => s.canonical(x) ?? x) : [...s.sigs.keys()].filter((k) => k.startsWith('/dev/')).sort()
    let code = 2
    for (const dev of devs) {
      const sig = s.sigs.get(dev)
      if (!sig) continue
      code = 0
      const tags: [string, string][] = [['UUID', sig.uuid]]
      if (sig.label) tags.unshift(['LABEL', sig.label])
      if (sig.type === 'xfs') tags.push(['BLOCK_SIZE', '512'])
      if (sig.type === 'ext4') tags.push(['BLOCK_SIZE', '4096'])
      tags.push(['TYPE', sig.type])
      if (/\d$/.test(dev) && !dev.startsWith('/dev/mapper')) tags.push(['PARTUUID', `${sig.uuid.slice(0, 8)}-0${dev.slice(-1)}`])
      const wanted = a.values.has('s') ? tags.filter(([k]) => k === a.values.get('s')) : tags
      if (a.values.get('o') === 'value') for (const [, v] of wanted) ctx.out(v + '\n')
      else ctx.out(`${dev}: ${wanted.map(([k, v]) => `${k}="${v}"`).join(' ')}\n`)
    }
    return code
  },
})

// ---------------------------------------------------------------------------------------
// Particiones: fdisk y parted
// ---------------------------------------------------------------------------------------

function fdiskList(s: Storage, d: Disk): string {
  const sectors = d.size / SECTOR
  let out = `Disk /dev/${d.name}: ${d.size % GiB === 0 ? `${d.size / GiB} GiB` : `${(d.size / GiB).toFixed(2)} GiB`}, ${d.size} bytes, ${sectors} sectors\nDisk model: ${d.model.padEnd(16)}\nUnits: sectors of 1 * 512 = 512 bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 512 bytes / 512 bytes\n`
  if (!d.label) return out
  out += `Disklabel type: ${d.label}\nDisk identifier: ${d.ptid}\n`
  if (!d.parts.length) return out
  out += '\n'
  const rows = d.parts.map((p) => ({ dev: s.partPath(d.name, p.num), start: String(p.start), end: String(p.end), sectors: String(p.end - p.start + 1), size: lsSize((p.end - p.start + 1) * SECTOR), p }))
  const w = (k: 'start' | 'end' | 'sectors' | 'size', head: string) => Math.max(head.length, ...rows.map((r) => r[k].length))
  const ws = { start: w('start', 'Start'), end: w('end', 'End'), sectors: w('sectors', 'Sectors'), size: w('size', 'Size') }
  const devW = Math.max(9, ...rows.map((r) => r.dev.length))
  if (d.label === 'dos') {
    out += `${'Device'.padEnd(devW)} Boot ${'Start'.padStart(ws.start)} ${'End'.padStart(ws.end)} ${'Sectors'.padStart(ws.sectors)} ${'Size'.padStart(ws.size)} Id Type\n`
    for (const r of rows) out += `${r.dev.padEnd(devW)} ${r.p.boot ? '*   ' : '    '} ${r.start.padStart(ws.start)} ${r.end.padStart(ws.end)} ${r.sectors.padStart(ws.sectors)} ${r.size.padStart(ws.size)} ${r.p.type.padStart(2)} ${MBR_TYPES[r.p.type] ?? 'Unknown'}\n`
  } else {
    out += `${'Device'.padEnd(devW)} ${'Start'.padStart(ws.start)} ${'End'.padStart(ws.end)} ${'Sectors'.padStart(ws.sectors)} ${'Size'.padStart(ws.size)} Type\n`
    for (const r of rows) out += `${r.dev.padEnd(devW)} ${r.start.padStart(ws.start)} ${r.end.padStart(ws.end)} ${r.sectors.padStart(ws.sectors)} ${r.size.padStart(ws.size)} ${r.p.type}\n`
  }
  return out
}

function lastUsable(d: Disk): number {
  return d.label === 'gpt' ? d.size / SECTOR - 34 : d.size / SECTOR - 1
}

/** Primer hueco libre del disco (alineado a 1 MiB). */
function freeRange(d: Disk): [number, number] | undefined {
  const used = [...d.parts].sort((a, b) => a.start - b.start)
  let cursor = 2048
  for (const p of used) {
    if (p.start - cursor >= 2048) return [cursor, p.start - 1]
    cursor = Math.ceil((p.end + 1) / 2048) * 2048
  }
  const end = d.label === 'gpt' ? Math.floor((lastUsable(d) + 1) / 2048) * 2048 - 1 : lastUsable(d)
  return end - cursor >= 2047 ? [cursor, end] : undefined
}

function partitionsBusy(s: Storage, d: Disk): string | undefined {
  for (const p of d.parts) {
    const h = s.holder(s.partPath(d.name, p.num))
    if (h) return s.partPath(d.name, p.num)
  }
  return undefined
}

const GPT_ALIASES: Record<string, string> = { linux: 'Linux filesystem', '20': 'Linux filesystem', lvm: 'Linux LVM', '44': 'Linux LVM', swap: 'Linux swap', '19': 'Linux swap', uefi: 'EFI System', '1': 'EFI System', '4': 'BIOS boot' }
const MBR_ALIASES: Record<string, string> = { linux: '83', lvm: '8e', swap: '82', uefi: 'ef' }

register('fdisk', {
  usage: 'fdisk [-l] [DEVICE]',
  summary: '  -l, --list  muestra las tablas de particiones\n  Sin -l abre el menú interactivo: n (nueva), d (borrar), t (tipo), p (mostrar), g (GPT), o (MBR), w (guardar), q (salir)',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const list = ctx.args.some((a) => a === '-l' || a === '--list')
    const devArg = ctx.args.find((a) => !a.startsWith('-'))
    if (ctx.sh.user !== 'root') {
      ctx.err(`fdisk: cannot open ${devArg ?? '/dev/sda'}: Permission denied\n`)
      return 1
    }
    if (list) {
      const disks = devArg ? [s.disks.get(devName(devArg))].filter((d): d is Disk => !!d) : [...s.disks.values()].sort((a, b) => a.name.localeCompare(b.name))
      if (devArg && !disks.length) {
        ctx.err(`fdisk: cannot open ${devArg}: No such file or directory\n`)
        return 1
      }
      ctx.out(disks.map((d) => fdiskList(s, d)).join('\n'))
      if (!devArg) {
        for (const vg of s.vgs.values()) {
          for (const lv of vg.lvs) {
            const p = s.lvPath(vg.name, lv.name)
            ctx.out(`\n\nDisk ${p}: ${(lv.size / GiB).toFixed(lv.size % GiB ? 2 : 0)} GiB, ${lv.size} bytes, ${lv.size / SECTOR} sectors\nUnits: sectors of 1 * 512 = 512 bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 512 bytes / 512 bytes\n`)
          }
        }
      }
      return 0
    }
    if (!devArg) {
      ctx.err('Usage:\n fdisk [options] <disk>         change partition table\n fdisk [options] -l [<disk>...] list partition table(s)\n')
      return 1
    }
    const d = s.disks.get(devName(devArg))
    if (!d) {
      ctx.err(`fdisk: cannot open ${devArg}: No such file or directory\n`)
      return 1
    }
    if (ctx.stdin.empty) {
      ctx.err(
        `Welcome to fdisk (util-linux 2.40.2).\nChanges will remain in memory only, until you decide to write them.\nBe careful before using the write command.\n\n[simulador] El menú interactivo de fdisk se practica en tu laboratorio. Aquí puedes pasarle las respuestas por una tubería, por ejemplo:\n  printf 'g\\nn\\n\\n\\n\\nw\\n' | sudo fdisk ${devArg}\no usar parted, que no es interactivo: sudo parted -s ${devArg} mklabel gpt mkpart datos 1MiB 100%\n`,
      )
      return 1
    }
    // Trabaja sobre una copia; se guarda solo con w.
    const work: Disk = { ...d, parts: d.parts.map((p) => ({ ...p })) }
    ctx.out('\nWelcome to fdisk (util-linux 2.40.2).\nChanges will remain in memory only, until you decide to write them.\nBe careful before using the write command.\n\n')
    if (!work.label) ctx.out(`Device does not contain a recognized partition table.\nCreated a new DOS (MBR) disklabel with disk identifier 0x${s.newUuid('vfat').replace('-', '').toLowerCase()}.\n\n`)
    if (!work.label) {
      work.label = 'dos'
      work.ptid = '0x' + s.newUuid('vfat').replace('-', '').toLowerCase()
    }
    const ask = (q: string): string | null => {
      ctx.out(q)
      const l = ctx.stdin.readLine()
      ctx.out((l ?? '') + '\n')
      return l
    }
    for (;;) {
      const cmd = ask('Command (m for help): ')
      if (cmd === null) {
        ctx.out('\n')
        return 0
      }
      const c = cmd.trim()
      if (c === 'g' || c === 'o') {
        work.label = c === 'g' ? 'gpt' : 'dos'
        work.parts = []
        work.ptid = c === 'g' ? s.newUuid('xfs').toUpperCase() : '0x' + s.newUuid('vfat').replace('-', '').toLowerCase()
        ctx.out(c === 'g' ? `Created a new GPT disklabel (GUID: ${work.ptid}).\n\n` : `Created a new DOS (MBR) disklabel with disk identifier ${work.ptid}.\n\n`)
      } else if (c === 'n') {
        if (work.label === 'dos') {
          const t = ask(`Partition type\n   p   primary (${work.parts.length} primary, 0 extended, ${4 - work.parts.length} free)\n   e   extended (container for logical partitions)\nSelect (default p): `)
          if (t && t.trim() && t.trim() !== 'p') {
            ctx.out('[simulador] Las particiones extendidas no se simulan: usa primarias o GPT.\n\n')
            continue
          }
        }
        const max = work.label === 'gpt' ? 128 : 4
        const next = [...Array(max).keys()].map((i) => i + 1).find((n) => !work.parts.some((p) => p.num === n))
        const range = freeRange(work)
        if (!next || !range) {
          ctx.out('No free sectors available.\n\n')
          continue
        }
        const numIn = ask(`Partition number (${next}-${max}, default ${next}): `)
        const num = numIn && numIn.trim() ? Number(numIn.trim()) : next
        const firstIn = ask(`First sector (${range[0]}-${range[1]}, default ${range[0]}): `)
        const first = firstIn && firstIn.trim() ? Number(firstIn.trim()) : range[0]
        const lastIn = ask(`Last sector, +/-sectors or +/-size{K,M,G,T,P} (${first}-${range[1]}, default ${range[1]}): `)
        let last = range[1]
        if (lastIn && lastIn.trim()) {
          const v = lastIn.trim()
          if (v.startsWith('+')) {
            const bytes = parseSize(v.slice(1), SECTOR)
            if (bytes === undefined) {
              ctx.out('Value out of range.\n')
              continue
            }
            last = first + Math.floor(bytes / SECTOR) - 1
          } else last = Number(v)
        }
        if (last > range[1] || last <= first) {
          ctx.out('Value out of range.\n\n')
          continue
        }
        const type = work.label === 'gpt' ? 'Linux filesystem' : '83'
        work.parts.push({ num, start: first, end: last, type })
        work.parts.sort((a, b) => a.num - b.num)
        ctx.out(`\nCreated a new partition ${num} of type '${work.label === 'gpt' ? type : 'Linux'}' and of size ${lsSize((last - first + 1) * SECTOR).replace(/([KMGT])$/, ' $1iB')}.\n\n`)
      } else if (c === 'd') {
        if (!work.parts.length) {
          ctx.out('No partition is defined yet!\n\n')
          continue
        }
        const n = work.parts.length === 1 ? work.parts[0].num : Number(ask(`Partition number (${work.parts.map((p) => p.num).join(',')}, default ${work.parts.at(-1)!.num}): `)?.trim() || work.parts.at(-1)!.num)
        work.parts = work.parts.filter((p) => p.num !== n)
        ctx.out(`Partition ${n} has been deleted.\n\n`)
      } else if (c === 't') {
        if (!work.parts.length) {
          ctx.out('No partition is defined yet!\n\n')
          continue
        }
        const n = work.parts.length === 1 ? work.parts[0].num : Number(ask(`Partition number (${work.parts.map((p) => p.num).join(',')}, default ${work.parts.at(-1)!.num}): `)?.trim() || work.parts.at(-1)!.num)
        if (work.parts.length === 1) ctx.out(`Selected partition ${n}\n`)
        const code = (ask(`${work.label === 'gpt' ? 'Partition type or alias (type L to list all)' : 'Hex code or alias (type L to list all)'}: `) ?? '').trim().toLowerCase()
        const part = work.parts.find((p) => p.num === n)!
        const type = work.label === 'gpt' ? GPT_ALIASES[code] : (MBR_ALIASES[code] ?? (MBR_TYPES[code] ? code : undefined))
        if (!type) {
          ctx.out('Failed to parse partition type.\n\n')
          continue
        }
        const old = work.label === 'gpt' ? part.type : MBR_TYPES[part.type]
        part.type = type
        ctx.out(`Changed type of partition '${old}' to '${work.label === 'gpt' ? type : MBR_TYPES[type]}'.\n\n`)
      } else if (c === 'p') {
        ctx.out(fdiskList(s, work) + '\n')
      } else if (c === 'w') {
        const busy = partitionsBusy(s, d)
        d.label = work.label
        d.ptid = work.ptid
        // Las firmas de particiones que desaparecen se pierden.
        for (const p of d.parts) if (!work.parts.some((x) => x.num === p.num && x.start === p.start)) s.sigs.delete(s.partPath(d.name, p.num))
        d.parts = work.parts
        s.syncDevFiles()
        ctx.out(`The partition table has been altered.\n${busy ? `Calling ioctl() to re-read partition table.\nRe-reading the partition table failed.: Device or resource busy\nThe kernel still uses the old table. The new table will be used at the next reboot or after you run partprobe(8) or partx(8).\n` : 'Calling ioctl() to re-read partition table.\n'}Syncing disks.\n\n`)
        return 0
      } else if (c === 'q') {
        return 0
      } else if (c === 'm') {
        ctx.out('Help:\n   d   delete a partition\n   n   add a new partition\n   p   print the partition table\n   t   change a partition type\n   g   create a new empty GPT partition table\n   o   create a new empty MBR (DOS) partition table\n   w   write table to disk and exit\n   q   quit without saving changes\n\n')
      } else if (c) ctx.out(`${c}: unknown command\n\n`)
    }
  },
})

/** Posición de parted (1MiB, 5GiB, 100%, 2048s, 500MB...) en sectores. */
function partedPos(d: Disk, text: string, isEnd: boolean): number | undefined {
  const total = d.size / SECTOR
  const usable = lastUsable(d)
  const m = /^(-?\d+(?:\.\d+)?)(%|s|B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)?$/.exec(text)
  if (!m) return undefined
  const v = Number(m[1])
  const unit = m[2] ?? 'MB'
  if (unit === '%') {
    if (v >= 100) return isEnd ? Math.floor((usable + 1) / 2048) * 2048 - 1 : usable
    return Math.round((total * v) / 100 / 2048) * 2048 - (isEnd ? 1 : 0)
  }
  if (unit === 's') return v
  const mult = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: MiB, GB: 1e9, GiB: GiB, TB: 1e12, TiB: 1024 * GiB }[unit]!
  const sec = Math.round((v * mult) / SECTOR)
  return isEnd ? sec - 1 : sec
}

register('parted', {
  usage: 'parted [-s] [DEVICE [COMMAND...]]',
  summary: '  print · mklabel gpt|msdos · mkpart NOMBRE [TIPO-FS] INICIO FIN · rm N · set N lvm on · resizepart N FIN\n  -s, --script  no hace preguntas',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const args = ctx.args.filter((x) => x !== '-s' && x !== '--script' && x !== '-a' && x !== 'optimal')
    const script = ctx.args.includes('-s') || ctx.args.includes('--script')
    if (ctx.args.includes('-l') || ctx.args.includes('--list')) {
      if (needRoot(ctx, 'Error: Could not stat device /dev/sda - Permission denied.\n')) return 1
      for (const d of [...s.disks.values()].sort((a, b) => a.name.localeCompare(b.name))) ctx.out(partedPrint(s, d) + '\n')
      return 0
    }
    const devArg = args[0]
    if (!devArg) {
      ctx.err('[simulador] Indica el disco: sudo parted /dev/sdb print\n')
      return 1
    }
    if (needRoot(ctx, `Error: Error opening ${devArg}: Permission denied\n`)) return 1
    const d = s.disks.get(devName(devArg))
    if (!d) {
      ctx.err(`Error: Could not stat device ${devArg} - No such file or directory.\n`)
      return 1
    }
    const words = args.slice(1)
    if (!words.length) {
      ctx.err(`GNU Parted 3.6\nUsing ${devArg}\n[simulador] El modo interactivo de parted se practica en tu laboratorio. Aquí escribe los comandos seguidos: sudo parted ${devArg} print, o sudo parted -s ${devArg} mklabel gpt mkpart datos 1MiB 100%\n`)
      return 1
    }
    let i = 0
    const noteShown = { v: false }
    while (i < words.length) {
      const cmd = words[i++]
      if (cmd === 'print' || cmd === 'p') {
        if (!d.label) ctx.err(`Error: ${devArg}: unrecognised disk label\n`)
        ctx.out(partedPrint(s, d))
      } else if (cmd === 'mklabel') {
        const lbl = words[i++]
        if (lbl !== 'gpt' && lbl !== 'msdos') {
          ctx.err(`parted: invalid token: ${lbl ?? ''}\n`)
          return 1
        }
        const busy = partitionsBusy(s, d)
        if (busy) {
          ctx.err(`Error: Partition(s) on ${devArg} are being used.\n`)
          return 1
        }
        if (d.label && !script && !askYes(ctx, `Warning: The existing disk label on ${devArg} will be destroyed and all data on this disk will be lost. Do you want to continue?\nYes/No? `, noteShown)) return 1
        for (const p of d.parts) s.sigs.delete(s.partPath(d.name, p.num))
        s.sigs.delete(`/dev/${d.name}`)
        d.label = lbl === 'gpt' ? 'gpt' : 'dos'
        d.ptid = lbl === 'gpt' ? s.newUuid('xfs').toUpperCase() : '0x' + s.newUuid('vfat').replace('-', '').toLowerCase()
        d.parts = []
      } else if (cmd === 'mkpart') {
        if (!d.label) {
          ctx.err(`Error: ${devArg}: unrecognised disk label\n`)
          return 1
        }
        let name: string | undefined
        if (d.label === 'dos') {
          const kind = words[i++]
          if (!['primary', 'logical', 'extended'].includes(kind)) {
            ctx.err(`parted: invalid token: ${kind}\n`)
            return 1
          }
          if (kind !== 'primary') {
            ctx.err('[simulador] Solo se simulan particiones primarias en MBR.\n')
            return 1
          }
        } else name = words[i++]
        let fsType: string | undefined
        if (words[i] && !/^-?\d/.test(words[i])) fsType = words[i++]
        const startTxt = words[i++]
        const endTxt = words[i++]
        if (!startTxt || !endTxt) {
          ctx.err('Error: Expecting a partition start and end.\n')
          return 1
        }
        let start = partedPos(d, startTxt, false)
        const end = partedPos(d, endTxt, true)
        if (start === undefined || end === undefined) {
          ctx.err(`Error: Invalid number.\n`)
          return 1
        }
        if (start < 2048) start = 2048
        if (end > lastUsable(d)) {
          ctx.err(`Error: The location ${endTxt} is outside of the device ${devArg}.\n`)
          return 1
        }
        if (d.parts.some((p) => !(end < p.start || start! > p.end))) {
          ctx.err("Error: Can't have overlapping partitions.\n")
          return 1
        }
        const max = d.label === 'gpt' ? 128 : 4
        const num = [...Array(max).keys()].map((x) => x + 1).find((n) => !d.parts.some((p) => p.num === n))
        if (!num) {
          ctx.err("Error: Too many primary partitions.\n")
          return 1
        }
        const type = d.label === 'gpt' ? (fsType === 'linux-swap' ? 'Linux swap' : 'Linux filesystem') : fsType === 'linux-swap' ? '82' : '83'
        d.parts.push({ num, start, end, type, name })
        d.parts.sort((a, b) => a.num - b.num)
      } else if (cmd === 'rm') {
        const n = Number(words[i++])
        const p = d.parts.find((x) => x.num === n)
        if (!p) {
          ctx.err(`Error: Partition doesn't exist.\n`)
          return 1
        }
        const h = s.holder(s.partPath(d.name, n))
        if (h) {
          ctx.err(`Error: Partition ${s.partPath(d.name, n)} is being used. You must unmount it before you modify it with Parted.\n`)
          return 1
        }
        s.sigs.delete(s.partPath(d.name, n))
        d.parts = d.parts.filter((x) => x.num !== n)
      } else if (cmd === 'set') {
        const n = Number(words[i++])
        const flag = words[i++]
        const state = words[i++]
        const p = d.parts.find((x) => x.num === n)
        if (!p) {
          ctx.err(`Error: Partition doesn't exist.\n`)
          return 1
        }
        const on = state === 'on'
        if (flag === 'lvm') p.type = on ? (d.label === 'gpt' ? 'Linux LVM' : '8e') : d.label === 'gpt' ? 'Linux filesystem' : '83'
        else if (flag === 'swap') p.type = on ? (d.label === 'gpt' ? 'Linux swap' : '82') : d.label === 'gpt' ? 'Linux filesystem' : '83'
        else if (flag === 'esp') p.type = on ? 'EFI System' : 'Linux filesystem'
        else if (flag === 'boot') p.boot = on
        else {
          ctx.err(`parted: invalid token: ${flag}\n`)
          return 1
        }
      } else if (cmd === 'resizepart') {
        const n = Number(words[i++])
        const endTxt = words[i++]
        const p = d.parts.find((x) => x.num === n)
        const end = endTxt ? partedPos(d, endTxt, true) : undefined
        if (!p || end === undefined) {
          ctx.err(`Error: Partition doesn't exist.\n`)
          return 1
        }
        if (d.parts.some((x) => x !== p && x.start > p.start && x.start <= end)) {
          ctx.err("Error: Can't have overlapping partitions.\n")
          return 1
        }
        p.end = end
      } else if (cmd === 'unit') {
        i++
      } else {
        ctx.err(`parted: invalid token: ${cmd}\n`)
        return 1
      }
    }
    s.syncDevFiles()
    if (words.some((w) => ['mkpart', 'mklabel', 'rm', 'resizepart'].includes(w)) && !script) ctx.out('Information: You may need to update /etc/fstab.\n\n')
    return 0
  },
})

function partedPrint(s: Storage, d: Disk): string {
  let out = `Model: QEMU ${d.model} (scsi)\nDisk /dev/${d.name}: ${partedSize(d.size)}\nSector size (logical/physical): 512B/512B\nPartition Table: ${d.label === 'dos' ? 'msdos' : (d.label ?? 'unknown')}\nDisk Flags: \n\n`
  if (!d.label) return out
  const fsName = (p: PartEntry) => {
    const sig = s.sigs.get(s.partPath(d.name, p.num))
    if (!sig) return ''
    return sig.type === 'swap' ? 'linux-swap(v1)' : sig.type === 'vfat' ? 'fat32' : sig.type === 'LVM2_member' ? '' : sig.type
  }
  const flags = (p: PartEntry) => [p.boot ? 'boot' : '', /LVM|^8e$/.test(p.type) ? 'lvm' : '', /swap|^82$/.test(p.type) ? 'swap' : '', p.type === 'EFI System' ? 'boot, esp' : '', p.type === 'BIOS boot' ? 'bios_grub' : ''].filter(Boolean).join(', ')
  const rows = d.parts.map((p) => [String(p.num), partedSize(p.start * SECTOR), partedSize((p.end + 1) * SECTOR), partedSize((p.end - p.start + 1) * SECTOR), d.label === 'dos' ? 'primary' : fsName(p), d.label === 'dos' ? fsName(p) : (p.name ?? ''), flags(p)])
  const head = d.label === 'dos' ? ['Number', 'Start', 'End', 'Size', 'Type', 'File system', 'Flags'] : ['Number', 'Start', 'End', 'Size', 'File system', 'Name', 'Flags']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  out += head.map((h, i) => h.padEnd(w[i])).join('  ').trimEnd() + '\n'
  for (const r of rows) out += r.map((c, i) => (i === 0 ? ` ${c}`.padEnd(w[i]) : c.padEnd(w[i]))).join('  ').trimEnd() + '\n'
  return out + '\n'
}

register(['partprobe', 'partx'], {
  usage: 'partprobe [DEVICE]',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'Error: Error opening /dev/sda: Permission denied\n')) return 1
    st(ctx).syncDevFiles()
    return 0
  },
})

register('wipefs', {
  usage: 'wipefs [-a] DEVICE',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const all = ctx.args.some((a) => a === '-a' || a === '--all')
    const dev = ctx.args.find((a) => !a.startsWith('-'))
    if (!dev) {
      ctx.err('wipefs: no device specified\n')
      return 1
    }
    if (needRoot(ctx, `wipefs: error: ${dev}: probing initialization failed: Permission denied\n`)) return 1
    const c = s.canonical(dev)
    if (!c) {
      ctx.err(`wipefs: error: ${dev}: probing initialization failed: No such file or directory\n`)
      return 1
    }
    const sig = s.sigs.get(c)
    const disk = s.disks.get(devName(c))
    if (all && (s.holder(c) || (disk && partitionsBusy(s, disk)))) {
      ctx.err(`wipefs: error: ${dev}: probing initialization failed: Device or resource busy\n`)
      return 1
    }
    const magic: Record<FsType, [string, string]> = { xfs: ['0x00000000', '58 46 53 42'], ext4: ['0x00000438', '53 ef'], vfat: ['0x00000052', '46 41 54 33 32 20 20 20'], swap: ['0x00000ff6', '53 57 41 50 53 50 41 43 45 32'], LVM2_member: ['0x00000218', '4c 56 4d 32 20 30 30 31'] }
    if (!all) {
      ctx.out('DEVICE OFFSET     TYPE UUID LABEL\n')
      if (sig) ctx.out(`${devName(c)} ${magic[sig.type][0]} ${sig.type} ${sig.uuid} ${sig.label ?? ''}\n`)
      if (disk?.label) ctx.out(`${devName(c)} 0x200      ${disk.label === 'dos' ? 'dos' : 'gpt'}\n`)
      return 0
    }
    if (sig) {
      ctx.out(`${c}: ${magic[sig.type][1].split(' ').length} bytes were erased at offset ${magic[sig.type][0]} (${sig.type}): ${magic[sig.type][1]}\n`)
      s.sigs.delete(c)
    }
    if (disk?.label) {
      ctx.out(disk.label === 'gpt' ? `${c}: 8 bytes were erased at offset 0x00000200 (gpt): 45 46 49 20 50 41 52 54\n${c}: 2 bytes were erased at offset 0x000001fe (PMBR): 55 aa\n` : `${c}: 2 bytes were erased at offset 0x000001fe (dos): 55 aa\n`)
      disk.label = undefined
      disk.parts = []
    }
    s.syncDevFiles()
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Sistemas de archivos y swap
// ---------------------------------------------------------------------------------------

function mkfs(ctx: CommandContext, type: FsType, args: string[]): number {
  const s = st(ctx)
  const a = parseArgs(args, { flags: { f: ['f', 'F', 'force'], q: ['q', 'quiet'] }, values: { L: ['L', 'n'] } })
  const dev = a.rest[0]
  const prog = type === 'xfs' ? 'mkfs.xfs' : type === 'ext4' ? 'mke2fs' : type === 'vfat' ? 'mkfs.fat' : 'mkswap'
  if (!dev) {
    ctx.err(`${prog}: no device specified\n`)
    return 1
  }
  if (needRoot(ctx, `${type === 'xfs' ? 'mkfs.xfs: cannot open' : `${prog}: cannot open`} ${dev}: Permission denied\n`)) return 1
  const c = s.canonical(dev)
  if (!c) {
    ctx.err(type === 'xfs' ? `Error accessing specified device ${dev}: No such file or directory\n` : `The file ${dev} does not exist and no size was specified.\n`)
    return 1
  }
  const disk = s.disks.get(devName(c))
  if (disk?.parts.length) {
    if (type === 'xfs') ctx.err(`mkfs.xfs: ${c} appears to contain a partition table (${disk.label}).\nmkfs.xfs: Use the -f option to force overwrite.\n`)
    else ctx.err(`Found a ${disk.label} partition table in ${c}\n[simulador] Ese disco tiene particiones: el sistema de archivos va en una partición (por ejemplo ${s.partPath(disk.name, disk.parts[0].num)}), no en el disco entero.\n`)
    if (!a.flags.has('f') || type !== 'xfs') return 1
  }
  const holder = s.holder(c)
  if (holder) {
    ctx.err(holder.startsWith('mounted') ? `${prog}: ${c} contains a mounted filesystem\n` : `${prog}: cannot open ${c}: Device or resource busy\n`)
    return 1
  }
  const old = s.sigs.get(c)
  if (old && type === 'xfs' && !a.flags.has('f')) {
    ctx.err(`mkfs.xfs: ${c} appears to contain an existing filesystem (${old.type}).\nmkfs.xfs: Use the -f option to force overwrite.\n`)
    return 1
  }
  if (old && type === 'ext4' && !a.flags.has('f')) {
    if (!askYes(ctx, `mke2fs 1.47.1 (20-May-2024)\n${c} contains a ${old.type} file system${old.label ? ` labelled '${old.label}'` : ''}\nProceed anyway? (y,N) `, { v: false })) return 1
  }
  const size = s.size(c)!
  const label = a.values.get('L')
  const sig = s.makeFs(c, type, label)
  const blocks = Math.floor(size / 4096)
  if (type === 'xfs') {
    const ag = 4
    ctx.out(
      `meta-data=${c.padEnd(22)} isize=512    agcount=${ag}, agsize=${Math.floor(blocks / ag)} blks\n         =                       sectsz=512   attr=2, projid32bit=1\n         =                       crc=1        finobt=1, sparse=1, rmapbt=1\n         =                       reflink=1    bigtime=1 inobtcount=1 nrext64=1\ndata     =                       bsize=4096   blocks=${blocks}, imaxpct=25\n         =                       sunit=0      swidth=0 blks\nnaming   =version 2              bsize=4096   ascii-ci=0, ftype=1\nlog      =internal log           bsize=4096   blocks=16384, version=2\n         =                       sectsz=512   sunit=0 blks, lazy-count=1\nrealtime =none                   extsz=4096   blocks=0, rtextents=0\nDiscarding blocks...Done.\n`,
    )
  } else if (type === 'ext4') {
    ctx.out(
      `${old ? '' : 'mke2fs 1.47.1 (20-May-2024)\n'}Discarding device blocks: done                            \nCreating filesystem with ${blocks} 4k blocks and ${Math.floor(blocks / 4)} inodes\nFilesystem UUID: ${sig.uuid}\nSuperblock backups stored on blocks: \n\t32768, 98304, 163840, 229376, 294912, 819200, 884736\n\nAllocating group tables: done                            \nWriting inode tables: done                            \nCreating journal (16384 blocks): done\nWriting superblocks and filesystem accounting information: done \n\n`,
    )
  } else if (type === 'vfat') ctx.out('mkfs.fat 4.2 (2021-01-31)\n')
  return 0
}

register('mkfs.xfs', { usage: 'mkfs.xfs [-f] [-L etiqueta] DISPOSITIVO', path: '/usr/sbin', run: (ctx) => mkfs(ctx, 'xfs', ctx.args) })
register(['mkfs.ext4', 'mke2fs'], { usage: 'mkfs.ext4 [-F] [-L etiqueta] DISPOSITIVO', path: '/usr/sbin', run: (ctx) => mkfs(ctx, 'ext4', ctx.args) })
register(['mkfs.vfat', 'mkfs.fat'], { usage: 'mkfs.vfat [-n etiqueta] DISPOSITIVO', path: '/usr/sbin', run: (ctx) => mkfs(ctx, 'vfat', ctx.args) })
register('mkfs', {
  usage: 'mkfs [-t TIPO] DISPOSITIVO',
  path: '/usr/sbin',
  run(ctx) {
    const i = ctx.args.indexOf('-t')
    const type = i >= 0 ? ctx.args[i + 1] : 'ext2'
    const rest = ctx.args.filter((_, j) => j !== i && j !== i + 1)
    if (type === 'xfs' || type === 'ext4' || type === 'vfat') return mkfs(ctx, type, rest)
    ctx.err(`mkfs: failed to execute mkfs.${type}: No such file or directory\n`)
    return 1
  },
})

register('mkswap', {
  usage: 'mkswap [-L etiqueta] DISPOSITIVO|ARCHIVO',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const a = parseArgs(ctx.args, { flags: { f: ['f', 'force'] }, values: { L: ['L', 'label'] } })
    const target = a.rest[0]
    if (!target) {
      ctx.err('mkswap: no device specified\n')
      return 1
    }
    if (needRoot(ctx, `mkswap: cannot open ${target}: Permission denied\n`)) return 1
    let key = s.canonical(target)
    let size = key ? s.size(key) : undefined
    if (!key) {
      const abs = ctx.sh.resolve(target)
      if (!ctx.sys.vfs.exists(abs)) {
        ctx.err(`mkswap: cannot open ${target}: No such file or directory\n`)
        return 1
      }
      const node = ctx.sys.vfs.stat(abs, ROOT_CRED)
      size = node.size ?? node.data.length
      key = abs
      if ((node.mode & 0o077) !== 0) ctx.err(`mkswap: ${abs}: insecure permissions 0${(node.mode & 0o777).toString(8)}, fix with: chmod 0600 ${abs}\n`)
      if (size < 40960) {
        ctx.err(`mkswap: error: swap area needs to be at least 40 KiB\n`)
        return 1
      }
    }
    if (s.swaps.some((w) => w.path === key) || s.holder(key)) {
      ctx.err(`mkswap: error: ${key} is mounted; will not make swapspace\n`)
      return 1
    }
    const sig: FsSig = { type: 'swap', uuid: s.newUuid('swap'), label: a.values.get('L'), size: size!, baseUsed: 0 }
    s.sigs.set(key, sig)
    s.syncDevFiles()
    ctx.out(`Setting up swapspace version 1, size = ${lsSize(size! - 4096).replace(/([KMGT])$/, ' $1iB')} (${size! - 4096} bytes)\n${sig.label ? `LABEL=${sig.label}, ` : 'no label, '}UUID=${sig.uuid}\n`)
    return 0
  },
})

function swapKey(s: Storage, ctx: CommandContext, arg: string): string | undefined {
  if (arg.startsWith('UUID=') || arg.startsWith('LABEL=')) return s.resolveSpec(arg)
  return s.canonical(arg) ?? (ctx.sys.vfs.exists(ctx.sh.resolve(arg)) ? ctx.sh.resolve(arg) : undefined)
}

register('swapon', {
  usage: 'swapon [-a] [--show] [DISPOSITIVO|ARCHIVO]',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const all = ctx.args.includes('-a') || ctx.args.includes('--all')
    const target = ctx.args.find((x) => !x.startsWith('-'))
    if ((!target && !all) || ctx.args.includes('--show') || ctx.args.includes('-s')) {
      if (ctx.args.includes('-s') || ctx.args.includes('--summary')) {
        ctx.out('Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n')
        for (const w of s.swaps) ctx.out(`${(s.findLv(w.path) ? `/dev/dm-${s.findLv(w.path)!.lv.minor}` : w.path).padEnd(40)}${w.type.padEnd(16)}${String(w.size / 1024 - 4).padEnd(16)}${String(w.used / 1024).padEnd(16)}${w.prio}\n`)
        return 0
      }
      if (!s.swaps.length) return 0
      ctx.out('NAME      TYPE      SIZE USED PRIO\n')
      for (const w of s.swaps) ctx.out(`${(s.findLv(w.path) ? `/dev/dm-${s.findLv(w.path)!.lv.minor}` : w.path).padEnd(10)}${w.type.padEnd(10)}${lsSize(w.size).padStart(4)} ${lsSize(w.used).padStart(4)} ${String(w.prio).padStart(4)}\n`)
      return 0
    }
    if (needRoot(ctx, `swapon: ${target ?? ''}: swapon failed: Operation not permitted\n`)) return 1
    const activate = (key: string, shown: string): boolean => {
      if (s.swaps.some((w) => w.path === key)) {
        if (!all) ctx.err(`swapon: ${shown}: swapon failed: Device or resource busy\n`)
        return !all ? false : true
      }
      const sig = s.sigs.get(key)
      if (!sig || sig.type !== 'swap') {
        ctx.err(`swapon: ${shown}: read swap header failed\n`)
        return false
      }
      if (!key.startsWith('/dev/')) {
        const mode = ctx.sys.vfs.stat(key, ROOT_CRED).mode & 0o777
        if (mode & 0o077) ctx.err(`swapon: ${key}: insecure permissions 0${mode.toString(8)}, 0600 suggested.\n`)
      }
      s.swaps.push({ path: key, type: key.startsWith('/dev/') ? 'partition' : 'file', size: sig.size, used: 0, prio: -2 - s.swaps.length })
      return true
    }
    if (all) {
      let ok = true
      for (const e of s.readFstab()) {
        if (e.type !== 'swap' || /\bnoauto\b/.test(e.options)) continue
        const key = swapKey(s, ctx, e.spec)
        if (!key) {
          if (!/\bnofail\b/.test(e.options)) {
            ctx.err(`swapon: cannot find the device for ${e.spec}\n`)
            ok = false
          }
          continue
        }
        if (!activate(key, e.spec)) ok = false
      }
      return ok ? 0 : 1
    }
    const key = swapKey(s, ctx, target!)
    if (!key) {
      ctx.err(`swapon: cannot open ${target}: No such file or directory\n`)
      return 1
    }
    return activate(key, target!) ? 0 : 1
  },
})

register('swapoff', {
  usage: 'swapoff [-a] [DISPOSITIVO|ARCHIVO]',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    if (needRoot(ctx, 'swapoff: Not superuser.\n')) return 1
    if (ctx.args.includes('-a')) {
      s.swaps = []
      return 0
    }
    const target = ctx.args.find((x) => !x.startsWith('-'))
    const key = target ? swapKey(s, ctx, target) : undefined
    if (!key || !s.swaps.some((w) => w.path === key)) {
      ctx.err(`swapoff: ${target ?? ''}: swapoff failed: Invalid argument\n`)
      return 1
    }
    s.swaps = s.swaps.filter((w) => w.path !== key)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// mount, umount, findmnt y df
// ---------------------------------------------------------------------------------------

const MOUNTABLE = new Set(['xfs', 'ext4', 'vfat'])
const KNOWN_TYPES = new Set(['xfs', 'ext4', 'ext3', 'ext2', 'vfat', 'btrfs', 'nfs', 'nfs4', 'cifs', 'tmpfs', 'swap', 'auto', 'iso9660', 'none'])

function fstabHint(ctx: CommandContext) {
  const s = st(ctx)
  if (s.fstabText() !== s.fstabSeen) ctx.err("mount: (hint) your fstab has been modified, but systemd still uses\n       the old version; use 'systemctl daemon-reload' to reload.\n")
}

/** Intenta montar; devuelve el mensaje de error (sin el prefijo "mount: TARGET: ") o undefined. */
function tryMount(ctx: CommandContext, spec: string, target: string, type: string | undefined, options: string): string | undefined {
  const s = st(ctx)
  const vfs = ctx.sys.vfs
  const abs = normalizePath(target)
  const dev = s.resolveSpec(spec)
  if (!dev) {
    if (spec.startsWith('UUID=') || spec.startsWith('LABEL=')) return `can't find ${spec}.`
    return `special device ${spec} does not exist.`
  }
  if (!vfs.exists(abs)) return 'mount point does not exist.'
  if (vfs.stat(abs, ROOT_CRED).type !== 'dir') return 'mount point is not a directory.'
  const sig = s.sigs.get(dev)
  const already = s.mounts.find((m) => m.dev === dev)
  if (already) return `${dev} already mounted on ${already.target}.`
  if (s.mounts.some((m) => m.target === abs)) {
    // Montar sobre algo ya montado es válido en Linux, pero confunde: el simulador lo avisa.
    return `${abs} is already a mount point. [simulador] Desmóntalo antes con umount.`
  }
  if (type && type !== 'auto' && !KNOWN_TYPES.has(type)) return `unknown filesystem type '${type}'.`
  if (!sig || !MOUNTABLE.has(sig.type)) {
    if (sig && (sig.type === 'swap' || sig.type === 'LVM2_member')) return `unknown filesystem type '${sig.type}'.`
    return `wrong fs type, bad option, bad superblock on ${dev}, missing codepage or helper program, or other error.`
  }
  if (type && type !== 'auto' && type !== sig.type) return `wrong fs type, bad option, bad superblock on ${dev}, missing codepage or helper program, or other error.`
  const opts = options.split(',').filter((o) => o && o !== 'defaults')
  const bad = opts.find((o) => !/^(rw|ro|noatime|relatime|nodev|nosuid|noexec|exec|suid|dev|sync|async|nofail|noauto|auto|user|nouser|_netdev|discard|x-systemd\.[\w.-]+(=.*)?|uid=\d+|gid=\d+|umask=\d+|context=.*|remount|defaults|errors=[\w-]+|shortname=\w+|prjquota|usrquota|grpquota|quota)$/.test(o))
  if (bad) return `wrong fs type, bad option, bad superblock on ${dev}, missing codepage or helper program, or other error.`
  const shown = opts.filter((o) => !['nofail', 'noauto', 'auto', '_netdev'].includes(o) && !o.startsWith('x-systemd'))
  const base = shown.includes('ro') ? 'ro' : 'rw'
  const rest = shown.filter((o) => o !== 'ro' && o !== 'rw')
  const final = [base, ...rest, ...(rest.some((o) => /atime/.test(o)) ? [] : ['relatime']), ...(sig.type === 'xfs' ? ['seclabel', 'attr2', 'inode64', 'logbufs=8', 'logbsize=32k', 'noquota'] : [])].join(',')
  s.mount(dev, abs, sig.type, final)
  return undefined
}

register('mount', {
  usage: 'mount [-a] [-t TIPO] [-o OPCIONES] [DISPOSITIVO] [CARPETA]',
  summary: '  sin argumentos: lista lo montado\n  -a        monta todo lo de /etc/fstab que falte\n  -o remount,rw   vuelve a montar con otras opciones',
  path: '/usr/bin',
  run(ctx) {
    const s = st(ctx)
    const a = parseArgs(ctx.args, { flags: { a: ['a', 'all'], v: ['v', 'verbose'] }, values: { t: ['t', 'types'], o: ['o', 'options'] } })
    if (!a.rest.length && !a.flags.has('a')) {
      const all: { source: string; target: string; fstype: string; options: string }[] = [...VIRTUAL_MOUNTS, ...s.mounts]
      all.sort((x, y) => x.target.split('/').length - y.target.split('/').length || x.target.localeCompare(y.target))
      for (const m of all) if (!a.values.has('t') || a.values.get('t') === m.fstype) ctx.out(`${m.source} on ${m.target} type ${m.fstype} (${m.options})\n`)
      return 0
    }
    const opts = a.values.get('o') ?? 'defaults'
    if (ctx.sh.user !== 'root') {
      ctx.err(`mount: ${a.rest.at(-1) ?? ''}: must be superuser to use mount.\n`)
      return 32
    }
    if (a.flags.has('a')) {
      let code = 0
      for (const e of s.readFstab()) {
        if (e.type === 'swap' || e.target === 'none' || /\bnoauto\b/.test(e.options)) continue
        if (s.mounts.some((m) => m.target === normalizePath(e.target))) continue
        const err = tryMount(ctx, e.spec, e.target, e.type, e.options)
        if (err) {
          if (/\bnofail\b/.test(e.options) && /can't find|does not exist/.test(err)) continue
          ctx.err(`mount: ${e.target}: ${err}\n`)
          code = 32
        } else if (a.flags.has('v')) ctx.out(`${e.target.padEnd(24)}: successfully mounted\n`)
      }
      fstabHint(ctx)
      return code
    }
    // remount
    if (opts.includes('remount')) {
      const target = normalizePath(ctx.sh.resolve(a.rest[0]))
      const m = s.mounts.find((x) => x.target === target)
      if (!m) {
        ctx.err(`mount: ${target}: mount point not mounted or bad option.\n`)
        return 32
      }
      const ro = /\bro\b/.test(opts)
      m.options = m.options.replace(/^r[ow]/, ro ? 'ro' : 'rw')
      return 0
    }
    if (a.rest.length === 1) {
      // Solo la carpeta (o el dispositivo): se busca en fstab.
      const arg = a.rest[0]
      const abs = arg.startsWith('/dev/') || arg.includes('=') ? arg : ctx.sh.resolve(arg)
      const e = s.readFstab().find((x) => normalizePath(x.target) === normalizePath(abs) || x.spec === arg)
      if (!e) {
        ctx.err(`mount: ${arg}: can't find in /etc/fstab.\n`)
        return 1
      }
      const err = tryMount(ctx, e.spec, e.target, e.type, `${e.options}${opts !== 'defaults' ? ',' + opts : ''}`)
      if (err) {
        ctx.err(`mount: ${e.target}: ${err}\n`)
        return 32
      }
      fstabHint(ctx)
      return 0
    }
    const spec = a.rest[0]
    const target = ctx.sh.resolve(a.rest[1])
    const err = tryMount(ctx, spec, target, a.values.get('t'), opts)
    if (err) {
      ctx.err(`mount: ${target}: ${err}\n`)
      return 32
    }
    fstabHint(ctx)
    return 0
  },
})

register('umount', {
  usage: 'umount CARPETA|DISPOSITIVO',
  path: '/usr/bin',
  run(ctx) {
    const s = st(ctx)
    const arg = ctx.args.find((x) => !x.startsWith('-'))
    if (!arg) {
      ctx.err('umount: bad usage\n')
      return 1
    }
    const dev = arg.startsWith('/dev/') ? s.canonical(arg) : undefined
    const abs = dev ? undefined : normalizePath(ctx.sh.resolve(arg))
    const m = s.mounts.find((x) => (dev ? x.dev === dev : x.target === abs))
    if (ctx.sh.user !== 'root') {
      ctx.err(`umount: ${arg}: must be superuser to unmount.\n`)
      return 32
    }
    if (!m) {
      ctx.err(`umount: ${arg}: not mounted.\n`)
      return 32
    }
    if (m.target === '/') {
      ctx.err('umount: /: target is busy.\n')
      return 32
    }
    const cwd = normalizePath(ctx.sh.cwd)
    const nested = s.mounts.some((x) => x !== m && x.target.startsWith(m.target + '/'))
    const openDeleted = s.liveDeleted().some((d) => d.dev === m.dev) || s.openFiles.some((o) => o.path.startsWith(m.target + '/') && ctx.sys.procs.some((p) => p.pid === o.pid))
    const busyProc = ctx.sys.procs.find((p) => p.cmd.includes(m.target + '/'))
    if (cwd === m.target || cwd.startsWith(m.target + '/') || nested || openDeleted || busyProc) {
      ctx.err(`umount: ${m.target}: target is busy.\n`)
      if (cwd === m.target || cwd.startsWith(m.target + '/')) ctx.err('[simulador] Tu propia sesión está dentro de esa carpeta: sal con cd antes de desmontar.\n')
      return 32
    }
    s.unmount(m)
    return 0
  },
})

register('findmnt', {
  usage: 'findmnt [--verify] [-s] [CARPETA|DISPOSITIVO]',
  summary: '  --verify   revisa /etc/fstab sin montar nada\n  -s         muestra lo que dice /etc/fstab\n  --df       espacio de cada montaje',
  run(ctx) {
    const s = st(ctx)
    if (ctx.args.includes('--verify') || ctx.args.includes('-x')) return verifyFstab(ctx)
    if (ctx.args.includes('-s') || ctx.args.includes('--fstab')) {
      const rows = s.readFstab().map((e) => [e.target, e.spec, e.type, e.options])
      printTable(ctx, ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS'], rows)
      return 0
    }
    const arg = ctx.args.find((x) => !x.startsWith('-'))
    const all: { source: string; target: string; fstype: string; options: string }[] = [...s.mounts, ...VIRTUAL_MOUNTS]
    if (ctx.args.includes('--df') || ctx.args.includes('-D')) {
      const rows = s.mounts.map((m) => {
        const sig = s.sigs.get(m.dev!)!
        const used = s.used(m.dev!)
        return [m.source, m.fstype, lsSize(sig.size), lsSize(used), lsSize(sig.size - used), `${Math.round((used / sig.size) * 100)}%`, m.target]
      })
      printTable(ctx, ['SOURCE', 'FSTYPE', 'SIZE', 'USED', 'AVAIL', 'USE%', 'TARGET'], rows)
      return 0
    }
    if (arg) {
      const dev = arg.startsWith('/dev/') ? s.canonical(arg) : undefined
      const abs = dev ? undefined : normalizePath(ctx.sh.resolve(arg))
      const m = all.find((x) => (dev ? (x as MountEntry).dev === dev : x.target === abs))
      if (!m) return 1
      printTable(ctx, ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS'], [[m.target, m.source, m.fstype, m.options]])
      return 0
    }
    const sorted = [...all].sort((x, y) => x.target.localeCompare(y.target))
    const parentOf = (t: string) => sorted.filter((x) => x.target !== t && (x.target === '/' || t.startsWith(x.target + '/'))).sort((x, y) => y.target.length - x.target.length)[0]?.target
    const lines: string[][] = []
    const walk = (t: string, prefix: string, isLast: boolean, depth: number) => {
      const m = sorted.find((x) => x.target === t)!
      lines.push([depth === 0 ? t : `${prefix}${isLast ? '└─' : '├─'}${t}`, m.source, m.fstype, m.options])
      const kids = sorted.filter((x) => parentOf(x.target) === t)
      kids.forEach((k, i) => walk(k.target, depth === 0 ? '' : prefix + (isLast ? '  ' : '│ '), i === kids.length - 1, depth + 1))
    }
    walk('/', '', true, 0)
    printTable(ctx, ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS'], lines)
    return 0
  },
})

function printTable(ctx: CommandContext, head: string[], rows: string[][]) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  ctx.out(head.map((h, i) => (i === head.length - 1 ? h : h.padEnd(w[i]))).join(' ') + '\n')
  for (const r of rows) ctx.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join(' ') + '\n')
}

function verifyFstab(ctx: CommandContext): number {
  const s = st(ctx)
  let errors = 0
  let warnings = 0
  let parse = 0
  const lines = s.fstabText().split('\n')
  const targets = new Set<string>()
  lines.forEach((raw) => {
    const l = raw.trim()
    if (!l || l.startsWith('#')) return
    const f = l.split(/\s+/)
    const msgs: string[] = []
    if (f.length < 4) {
      parse++
      ctx.out(`${f[1] ?? f[0]}\n   [E] parse error: not enough fields\n`)
      return
    }
    const [spec, target, type, options] = f
    if (targets.has(target) && target !== 'none') {
      msgs.push(`   [W] ${target} seems to be listed more than once`)
      warnings++
    }
    targets.add(target)
    const isSwap = type === 'swap'
    if (!isSwap && target !== 'none' && !ctx.sys.vfs.exists(target)) {
      msgs.push(`   [E] target does not exist`)
      errors++
    }
    const dev = isSwap ? (swapKey(s, ctx, spec) ?? s.resolveSpec(spec)) : s.resolveSpec(spec)
    if (!dev) {
      if (/\bnofail\b/.test(options)) {
        msgs.push(`   [W] unreachable on boot required source: ${spec}`)
        warnings++
      } else {
        msgs.push(`   [E] unreachable source: ${spec}`)
        errors++
      }
    } else if (!KNOWN_TYPES.has(type)) {
      msgs.push(`   [E] unsupported filesystem type ${type}`)
      errors++
    } else {
      const sig = s.sigs.get(dev)
      if (!sig) {
        msgs.push(`   [W] cannot detect on-disk filesystem type`)
        warnings++
      } else if (sig.type !== type && type !== 'auto') {
        msgs.push(`   [E] ${type} does not match with on-disk ${sig.type}`)
        errors++
      }
    }
    if (msgs.length) ctx.out(`${target}\n${msgs.join('\n')}\n`)
  })
  if (!errors && !warnings && !parse) ctx.out('Success, no errors or warnings detected\n')
  else ctx.out(`\n${parse} parse errors, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}\n`)
  return errors || parse ? 1 : 0
}

register('df', {
  usage: 'df [OPTION]... [FILE]...',
  summary: '  -h, --human-readable (potencias de 1024)  -H, --si (potencias de 1000)  -T, --print-type  -i  inodos',
  run(ctx) {
    const s = st(ctx)
    const si = ctx.args.some((a) => /^-\w*H/.test(a) || a === '--si')
    const h = si || ctx.args.some((a) => /^-\w*h/.test(a) || a === '--human-readable')
    const T = ctx.args.some((a) => /^-\w*T/.test(a) || a === '--print-type')
    const inodes = ctx.args.some((a) => /^-\w*i/.test(a) || a === '--inodes')
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    const typeFilter = ctx.args.find((a) => a.startsWith('--type='))?.slice(7) ?? (ctx.args.includes('-t') ? ctx.args[ctx.args.indexOf('-t') + 1] : undefined)
    type DfRow = { dev: string; type: string; size: number; used: number; target: string }
    let rows: DfRow[] = [
      ...s.mounts.filter((m) => m.dev).map((m) => ({ dev: m.source, type: m.fstype, size: s.sigs.get(m.dev!)!.size, used: s.used(m.dev!), target: m.target })),
      { dev: 'tmpfs', type: 'tmpfs', size: 1_921_788 * 1024, used: 0, target: '/dev/shm' },
      { dev: 'tmpfs', type: 'tmpfs', size: 768_716 * 1024, used: 8_840 * 1024, target: '/run' },
    ]
    rows.sort((a, b) => (a.target === '/' ? -1 : b.target === '/' ? 1 : 0))
    if (typeFilter) rows = rows.filter((r) => r.type === typeFilter)
    if (files.length) {
      const picked: DfRow[] = []
      for (const f of files) {
        const abs = ctx.sh.resolve(f)
        if (!ctx.sys.vfs.exists(abs)) {
          ctx.err(`df: ${f}: No such file or directory\n`)
          continue
        }
        const m = s.mountOfPath(abs)
        const r = rows.find((x) => x.target === m?.target)
        if (r && !picked.includes(r)) picked.push(r)
      }
      rows = picked
      if (!rows.length) return 1
    }
    const fmt = (bytes: number) => (h ? dfHuman(bytes, si) : String(Math.ceil(bytes / 1024)))
    const devW = Math.max(14, ...rows.map((r) => r.dev.length)) + 1
    // --output=campo,campo: columnas a elección (lo más cómodo para scripts).
    const outArg = ctx.args.find((a) => a.startsWith('--output'))
    if (outArg) {
      const fields = (outArg.includes('=') ? outArg.split('=')[1] : 'source,fstype,itotal,iused,iavail,ipcent,size,used,avail,pcent,file,target').split(',')
      const head: Record<string, string> = { source: 'Filesystem', fstype: 'Type', size: h ? 'Size' : '1K-blocks', used: 'Used', avail: 'Avail', pcent: 'Use%', target: 'Mounted on', itotal: 'Inodes', iused: 'IUsed', iavail: 'IFree', ipcent: 'IUse%', file: 'File' }
      const bad = fields.find((f) => !head[f])
      if (bad) {
        ctx.err(`df: option --output: field '${bad}' unknown\nTry 'df --help' for more information.\n`)
        return 1
      }
      const val = (r: DfRow, f: string): string => {
        const avail = Math.max(0, r.size - r.used)
        const total = Math.floor(r.size / 4096 / 4)
        const iu = Math.min(total, Math.round(r.used / 16384))
        switch (f) {
          case 'source':
            return r.dev
          case 'fstype':
            return r.type
          case 'size':
            return fmt(r.size)
          case 'used':
            return fmt(r.used)
          case 'avail':
            return fmt(avail)
          case 'pcent':
            return `${r.size ? Math.ceil((r.used / r.size) * 100) : 0}%`
          case 'itotal':
            return String(total)
          case 'iused':
            return String(iu)
          case 'iavail':
            return String(total - iu)
          case 'ipcent':
            return `${total ? Math.ceil((iu / total) * 100) : 0}%`
          case 'file':
            return files[0] ?? '-'
          default:
            return r.target
        }
      }
      const table = [fields.map((f) => head[f]), ...rows.map((r) => fields.map((f) => val(r, f)))]
      const widths = fields.map((_, k) => Math.max(...table.map((row) => row[k].length)))
      for (const row of table) ctx.out(row.map((c, k) => (['source', 'fstype', 'target', 'file'].includes(fields[k]) ? c.padEnd(widths[k]) : c.padStart(widths[k]))).join(' ').trimEnd() + '\n')
      return 0
    }
    if (inodes) {
      ctx.out(`${'Filesystem'.padEnd(devW)}${T ? 'Type   ' : ''}${'Inodes'.padStart(9)}${'IUsed'.padStart(7)}${'IFree'.padStart(9)} IUse% Mounted on\n`)
      for (const r of rows) {
        const total = Math.floor(r.size / 4096 / 4)
        const used = Math.min(total, Math.round(r.used / 16384))
        ctx.out(`${r.dev.padEnd(devW)}${T ? r.type.padEnd(7) : ''}${String(total).padStart(9)}${String(used).padStart(7)}${String(total - used).padStart(9)} ${String(total ? Math.ceil((used / total) * 100) : 0).padStart(4)}% ${r.target}\n`)
      }
      return 0
    }
    ctx.out(`${'Filesystem'.padEnd(devW)}${T ? 'Type   ' : ''}${(h ? 'Size' : '1K-blocks').padStart(10)}${'Used'.padStart(10)}${'Avail'.padStart(10)} Use% Mounted on\n`)
    for (const r of rows) {
      const avail = Math.max(0, r.size - r.used)
      ctx.out(`${r.dev.padEnd(devW)}${T ? r.type.padEnd(7) : ''}${fmt(r.size).padStart(10)}${fmt(r.used).padStart(10)}${fmt(avail).padStart(10)} ${String(r.size ? Math.ceil((r.used / r.size) * 100) : 0).padStart(3)}% ${r.target}\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// LVM
// ---------------------------------------------------------------------------------------

const LVM_DENIED = '  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/P_global:aux: open failed: Permission denied\n'

function lvTarget(s: Storage, arg: string): { vg: VG; lv: { name: string; size: number; minor: number } } | undefined {
  const plain = /^([^/]+)\/([^/]+)$/.exec(arg)
  if (plain) {
    const vg = s.vgs.get(plain[1])
    const lv = vg?.lvs.find((l) => l.name === plain[2])
    return vg && lv ? { vg, lv } : undefined
  }
  return s.findLv(s.canonical(arg) ?? arg)
}

function pvCreate(ctx: CommandContext, dev: string, quietNew = false): boolean {
  const s = st(ctx)
  const c = s.canonical(dev)
  if (!c) {
    ctx.err(`  No device found for ${dev}.\n`)
    return false
  }
  const disk = s.disks.get(devName(c))
  if (disk?.parts.length) {
    ctx.err(`  Cannot use ${c}: device is partitioned\n`)
    return false
  }
  const holder = s.holder(c)
  if (holder?.startsWith('mounted') || holder === 'used as swap') {
    ctx.err(`  Can't open ${c} exclusively.  Mounted filesystem?\n  Can't open ${c} exclusively.  Mounted filesystem?\n`)
    return false
  }
  const sig = s.sigs.get(c)
  if (sig?.type === 'LVM2_member') {
    if (s.vgOf(c)) {
      ctx.err(`  Can't initialize physical volume "${c}" of volume group "${s.vgOf(c)!.name}" without -ff\n  ${c}: physical volume not initialized.\n`)
      return false
    }
    return true
  }
  if (sig && !askYes(ctx, `WARNING: ${sig.type} signature detected on ${c} at offset 0. Wipe it? [y/n]: `, { v: false })) return false
  if (sig) ctx.out(`  Wiping ${sig.type} signature on ${c}.\n`)
  s.sigs.set(c, { type: 'LVM2_member', uuid: s.newUuid('LVM2_member'), size: s.size(c)!, baseUsed: 0 })
  if (!quietNew) ctx.out(`  Physical volume "${c}" successfully created.\n`)
  else ctx.out(`  Physical volume "${c}" successfully created.\n`)
  s.syncDevFiles()
  return true
}

register('pvcreate', {
  usage: 'pvcreate DISPOSITIVO...',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const devs = ctx.args.filter((x) => !x.startsWith('-'))
    if (!devs.length) {
      ctx.err('  Please enter a physical volume path.\n')
      return 3
    }
    let ok = true
    for (const d of devs) if (!pvCreate(ctx, d)) ok = false
    return ok ? 0 : 5
  },
})

register('pvs', {
  usage: 'pvs',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const pvs = [...s.sigs.entries()].filter(([, sig]) => sig.type === 'LVM2_member').map(([d]) => d).sort()
    const rows = pvs.map((p) => {
      const vg = s.vgOf(p)
      const size = vg ? s.pvExtents(p) * EXTENT : (s.size(p) ?? 0)
      const free = vg ? size - s.pvUsed(p) : size
      return [`  ${p}`, vg?.name ?? '', 'lvm2', vg ? 'a--' : '---', lvmSize(size), lvmSize(free)]
    })
    printLvm(ctx, ['  PV', 'VG', 'Fmt', 'Attr', 'PSize', 'PFree'], rows, [4, 5])
    return 0
  },
})

function printLvm(ctx: CommandContext, head: string[], rows: string[][], right: number[]) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const fmt = (r: string[]) => r.map((c, i) => (right.includes(i) ? c.padStart(w[i]) : c.padEnd(w[i]))).join(' ').trimEnd()
  ctx.out(fmt(head) + '\n')
  for (const r of rows) ctx.out(fmt(r) + '\n')
}

register('pvdisplay', {
  usage: 'pvdisplay [PV]',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const only = ctx.args.find((x) => !x.startsWith('-'))
    for (const [p, sig] of s.sigs) {
      if (sig.type !== 'LVM2_member' || (only && s.canonical(only) !== p)) continue
      const vg = s.vgOf(p)
      const pe = s.pvExtents(p)
      const used = Math.round(s.pvUsed(p) / EXTENT)
      ctx.out(
        vg
          ? `  --- Physical volume ---\n  PV Name               ${p}\n  VG Name               ${vg.name}\n  PV Size               ${lvmLong(s.size(p)!)} / not usable 4.00 MiB\n  Allocatable           yes ${pe === used ? '(but full)' : ''}\n  PE Size               4.00 MiB\n  Total PE              ${pe}\n  Free PE               ${pe - used}\n  Allocated PE          ${used}\n  PV UUID               ${sig.uuid}\n\n`
          : `  "${p}" is a new physical volume of "${lvmLong(s.size(p)!)}"\n  --- NEW Physical volume ---\n  PV Name               ${p}\n  VG Name               \n  PV Size               ${lvmLong(s.size(p)!)}\n  Allocatable           NO\n  PE Size               0   \n  Total PE              0\n  Free PE               0\n  Allocated PE          0\n  PV UUID               ${sig.uuid}\n\n`,
      )
    }
    return 0
  },
})

register('pvremove', {
  usage: 'pvremove PV',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const p = s.canonical(ctx.args.find((x) => !x.startsWith('-')) ?? '')
    if (!p || s.sigs.get(p)?.type !== 'LVM2_member') {
      ctx.err(`  No PV found on device ${ctx.args[0] ?? ''}.\n`)
      return 5
    }
    if (s.vgOf(p)) {
      ctx.err(`  PV ${p} is used by VG ${s.vgOf(p)!.name} so please use vgreduce first.\n  (If you are certain you need pvremove, then confirm by using --force twice.)\n`)
      return 5
    }
    s.sigs.delete(p)
    ctx.out(`  Labels on physical volume "${p}" successfully wiped.\n`)
    return 0
  },
})

register('vgcreate', {
  usage: 'vgcreate VG PV...',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const [name, ...devs] = ctx.args.filter((x) => !x.startsWith('-'))
    if (!name || !devs.length) {
      ctx.err('  Please provide volume group name and physical volumes\n')
      return 3
    }
    if (s.vgs.has(name)) {
      ctx.err(`  A volume group called ${name} already exists.\n`)
      return 5
    }
    const pvs: string[] = []
    for (const d of devs) {
      const c = s.canonical(d)
      if (c && s.vgOf(c)) {
        ctx.err(`  Physical volume '${c}' is already in volume group '${s.vgOf(c)!.name}'\n  Unable to add physical volume '${c}' to volume group '${name}'\n  ${c}: physical volume not initialized.\n`)
        return 5
      }
      if (!c || s.sigs.get(c)?.type !== 'LVM2_member') {
        if (!pvCreate(ctx, d, true)) return 5
      }
      pvs.push(s.canonical(d)!)
    }
    s.vgs.set(name, { name, uuid: s.newUuid('LVM2_member'), pvs, lvs: [] })
    s.syncDevFiles()
    ctx.out(`  Volume group "${name}" successfully created\n`)
    return 0
  },
})

register('vgextend', {
  usage: 'vgextend VG PV...',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const [name, ...devs] = ctx.args.filter((x) => !x.startsWith('-'))
    const vg = s.vgs.get(name ?? '')
    if (!vg) {
      ctx.err(`  Volume group "${name}" not found\n  Cannot process volume group ${name}\n`)
      return 5
    }
    for (const d of devs) {
      const c = s.canonical(d)
      if (c && s.vgOf(c)) {
        ctx.err(`  Physical volume '${c}' is already in volume group '${s.vgOf(c)!.name}'\n`)
        return 5
      }
      if (!c || s.sigs.get(c)?.type !== 'LVM2_member') if (!pvCreate(ctx, d, true)) return 5
      vg.pvs.push(s.canonical(d)!)
    }
    ctx.out(`  Volume group "${name}" successfully extended\n`)
    return 0
  },
})

register('vgs', {
  usage: 'vgs',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const rows = [...s.vgs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((v) => [`  ${v.name}`, String(v.pvs.length), String(v.lvs.length), '0', 'wz--n-', lvmSize(s.vgTotal(v)), lvmSize(s.vgFree(v))])
    printLvm(ctx, ['  VG', '#PV', '#LV', '#SN', 'Attr', 'VSize', 'VFree'], rows, [1, 2, 3, 5, 6])
    return 0
  },
})

register('vgdisplay', {
  usage: 'vgdisplay [VG]',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const only = ctx.args.find((x) => !x.startsWith('-'))
    for (const v of s.vgs.values()) {
      if (only && v.name !== only) continue
      const total = s.vgTotal(v) / EXTENT
      const free = s.vgFree(v) / EXTENT
      ctx.out(
        `  --- Volume group ---\n  VG Name               ${v.name}\n  System ID             \n  Format                lvm2\n  VG Access             read/write\n  VG Status             resizable\n  Cur LV                ${v.lvs.length}\n  Open LV               ${v.lvs.filter((l) => s.holder(s.lvPath(v.name, l.name))).length}\n  Cur PV                ${v.pvs.length}\n  Act PV                ${v.pvs.length}\n  VG Size               ${lvmLong(s.vgTotal(v))}\n  PE Size               4.00 MiB\n  Total PE              ${total}\n  Alloc PE / Size       ${total - free} / ${lvmLong((total - free) * EXTENT)}\n  Free  PE / Size       ${free} / ${lvmLong(free * EXTENT)}\n  VG UUID               ${v.uuid}\n\n`,
      )
    }
    return 0
  },
})

register('vgremove', {
  usage: 'vgremove VG',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const name = ctx.args.find((x) => !x.startsWith('-')) ?? ''
    const vg = s.vgs.get(name)
    if (!vg) {
      ctx.err(`  Volume group "${name}" not found\n`)
      return 5
    }
    for (const lv of vg.lvs) {
      if (s.holder(s.lvPath(vg.name, lv.name))) {
        ctx.err(`  Logical volume ${vg.name}/${lv.name} contains a filesystem in use.\n`)
        return 5
      }
    }
    if (vg.lvs.length && !askYes(ctx, `Do you really want to remove volume group "${name}" containing ${vg.lvs.length} logical volumes? [y/n]: `, { v: false })) return 5
    for (const lv of vg.lvs) {
      s.sigs.delete(s.lvPath(vg.name, lv.name))
      ctx.out(`  Logical volume "${lv.name}" successfully removed.\n`)
    }
    s.vgs.delete(name)
    s.syncDevFiles()
    ctx.out(`  Volume group "${name}" successfully removed\n`)
    return 0
  },
})

/** Interpreta -L y -l de lvcreate/lvextend: devuelve bytes (absolutos o relativos). */
function lvSizeArg(s: Storage, vg: VG, L?: string, l?: string, current = 0): { size?: number; error?: string } {
  if (L) {
    const rel = L.startsWith('+') ? 1 : L.startsWith('-') ? -1 : 0
    const v = parseSize(L.replace(/^[+-]/, ''), MiB)
    if (v === undefined) return { error: `  Invalid argument for --size: ${L}` }
    const ext = Math.ceil(v / EXTENT) * EXTENT
    return { size: rel ? current + rel * ext : ext }
  }
  if (l) {
    const rel = l.startsWith('+') ? 1 : 0
    const t = l.replace(/^\+/, '')
    const pct = /^(\d+)%(FREE|VG)$/i.exec(t)
    let ext: number
    if (pct) ext = Math.floor(((pct[2].toUpperCase() === 'FREE' ? s.vgFree(vg) : s.vgTotal(vg)) / EXTENT) * (Number(pct[1]) / 100))
    else if (/^\d+$/.test(t)) ext = Number(t)
    else return { error: `  Invalid argument for --extents: ${l}` }
    return { size: (rel ? current : 0) + ext * EXTENT }
  }
  return { error: '  Please specify either size or extents' }
}

register('lvcreate', {
  usage: 'lvcreate -n NOMBRE -L TAMAÑO|-l EXTENTS VG',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const a = parseArgs(ctx.args, { flags: { y: ['y', 'yes'] }, values: { n: ['n', 'name'], L: ['L', 'size'], l: ['l', 'extents'] } })
    const vgName = a.rest[0]?.split('/')[0]
    const vg = s.vgs.get(vgName ?? '')
    if (!vg) {
      ctx.err(vgName ? `  Volume group "${vgName}" not found\n  Cannot process volume group ${vgName}\n` : '  Please specify a volume group\n')
      return 5
    }
    const name = a.values.get('n') ?? `lvol${vg.lvs.length}`
    if (vg.lvs.some((l) => l.name === name)) {
      ctx.err(`  Logical Volume "${name}" already exists in volume group "${vg.name}"\n`)
      return 5
    }
    const r = lvSizeArg(s, vg, a.values.get('L'), a.values.get('l'))
    if (r.error) {
      ctx.err(r.error + '\n')
      return 3
    }
    const need = r.size! / EXTENT
    const free = s.vgFree(vg) / EXTENT
    if (need > free) {
      ctx.err(`  Volume group "${vg.name}" has insufficient free space (${free} extents): ${need} required.\n`)
      return 5
    }
    if (a.values.has('L') && (parseSize(a.values.get('L')!, MiB) ?? 0) % EXTENT) ctx.out(`  Rounding up size to full physical extent ${lvmLong(r.size!)}.\n`)
    s.addLv(vg, name, r.size!)
    ctx.out(`  Logical volume "${name}" created.\n`)
    return 0
  },
})

register('lvs', {
  usage: 'lvs',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const rows: string[][] = []
    for (const vg of [...s.vgs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      for (const lv of vg.lvs) rows.push([`  ${lv.name}`, vg.name, s.holder(s.lvPath(vg.name, lv.name)) ? '-wi-ao----' : '-wi-a-----', lvmSize(lv.size)])
    }
    printLvm(ctx, ['  LV', 'VG', 'Attr', 'LSize'], rows, [3])
    return 0
  },
})

register('lvdisplay', {
  usage: 'lvdisplay [LV]',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const only = ctx.args.find((x) => !x.startsWith('-'))
    const target = only ? lvTarget(s, only) : undefined
    for (const vg of s.vgs.values()) {
      for (const lv of vg.lvs) {
        if (only && (target?.lv !== lv || target?.vg !== vg)) continue
        ctx.out(
          `  --- Logical volume ---\n  LV Path                /dev/${vg.name}/${lv.name}\n  LV Name                ${lv.name}\n  VG Name                ${vg.name}\n  LV Write Access        read/write\n  LV Status              available\n  # open                 ${s.holder(s.lvPath(vg.name, lv.name)) ? 1 : 0}\n  LV Size                ${lvmLong(lv.size)}\n  Current LE             ${lv.size / EXTENT}\n  Segments               1\n  Allocation             inherit\n  Read ahead sectors     auto\n  Block device           253:${lv.minor}\n\n`,
        )
      }
    }
    return 0
  },
})

function growFs(ctx: CommandContext, dev: string): void {
  const s = st(ctx)
  const sig = s.sigs.get(dev)
  if (!sig) return
  const size = s.size(dev)!
  const oldBlocks = Math.floor(sig.size / 4096)
  const newBlocks = Math.floor(size / 4096)
  if (sig.type === 'xfs') {
    const m = s.mounts.find((x) => x.dev === dev)
    ctx.out(`meta-data=${dev.padEnd(22)} isize=512    agcount=4, agsize=${Math.floor(oldBlocks / 4)} blks\n         =                       sectsz=512   attr=2, projid32bit=1\ndata     =                       bsize=4096   blocks=${oldBlocks}, imaxpct=25\nlog      =internal log           bsize=4096   blocks=16384, version=2\ndata blocks changed from ${oldBlocks} to ${newBlocks}\n`)
    void m
  } else if (sig.type === 'ext4') {
    const m = s.mounts.find((x) => x.dev === dev)
    ctx.out(`resize2fs 1.47.1 (20-May-2024)\n${m ? `Filesystem at ${dev} is mounted on ${m.target}; on-line resizing required\nold_desc_blocks = 1, new_desc_blocks = 1\n` : ''}The filesystem on ${dev} is now ${newBlocks} (4k) blocks long.\n\n`)
  }
  sig.size = size
}

function lvResize(ctx: CommandContext, grow: 'extend' | 'reduce' | 'resize'): number {
  if (needRoot(ctx, LVM_DENIED)) return 5
  const s = st(ctx)
  const a = parseArgs(ctx.args, { flags: { r: ['r', 'resizefs'], y: ['y', 'yes'], f: ['f', 'force'] }, values: { L: ['L', 'size'], l: ['l', 'extents'] } })
  const target = a.rest[0] ? lvTarget(s, a.rest[0]) : undefined
  if (!target) {
    ctx.err(`  Failed to find logical volume "${a.rest[0] ?? ''}"\n`)
    return 5
  }
  const { vg, lv } = target
  const dev = s.lvPath(vg.name, lv.name)
  // Discos agregados al VG después: los PV que se pasan como argumento extra son solo de dónde tomar espacio.
  const r = lvSizeArg(s, vg, a.values.get('L'), a.values.get('l'), lv.size)
  if (r.error) {
    ctx.err(r.error + '\n')
    return 3
  }
  const newSize = r.size!
  const name = `${vg.name}/${lv.name}`
  if (newSize === lv.size) {
    ctx.err(`  New size (${lv.size / EXTENT} extents) matches existing size (${lv.size / EXTENT} extents).\n`)
    return 5
  }
  if (grow === 'extend' && newSize < lv.size) {
    ctx.err(`  New size given (${newSize / EXTENT} extents) not larger than existing size (${lv.size / EXTENT} extents)\n`)
    return 5
  }
  if (grow === 'reduce' && newSize > lv.size) {
    ctx.err(`  New size given (${newSize / EXTENT} extents) not less than existing size (${lv.size / EXTENT} extents)\n`)
    return 5
  }
  if (newSize - lv.size > s.vgFree(vg)) {
    ctx.err(`  Insufficient free space: ${(newSize - lv.size) / EXTENT} extents needed, but only ${s.vgFree(vg) / EXTENT} available\n`)
    return 5
  }
  const sig = s.sigs.get(dev)
  const mounted = s.mounts.find((m) => m.dev === dev)
  if (newSize < lv.size) {
    if (sig?.type === 'xfs') {
      ctx.err(`  File system xfs found on ${name}.\n  File system size (${lvmLong(sig.size)}) is larger than the requested size (${lvmLong(newSize)}).\n  File system reduce is required and not supported (xfs).\n`)
      return 5
    }
    if (sig && a.flags.has('r') && mounted) {
      ctx.err(`  File system ext4 found on ${name} mounted at ${mounted.target}.\n  File system size (${lvmLong(sig.size)}) is larger than the requested size (${lvmLong(newSize)}).\n  File system reduce is required and requires unmounting the file system.\n  [simulador] Desmonta ${mounted.target} antes de achicar.\n`)
      return 5
    }
    if (sig && !a.flags.has('r')) {
      ctx.err(`  File system ${sig.type} found on ${name}.\n  File system size (${lvmLong(sig.size)}) is larger than the requested size (${lvmLong(newSize)}).\n  File system reduce is required (see resize2fs or --resizefs.)\n`)
      return 5
    }
    if (sig && s.used(dev) > newSize) {
      ctx.err(`  resize2fs: No space left on device while trying to resize ${dev}\n  [simulador] Los datos no entran en el tamaño nuevo.\n`)
      return 5
    }
    if (sig) sig.size = newSize
  }
  ctx.out(`  Size of logical volume ${name} changed from ${lvmLong(lv.size)} (${lv.size / EXTENT} extents) to ${lvmLong(newSize)} (${newSize / EXTENT} extents).\n`)
  lv.size = newSize
  if (newSize > (sig?.size ?? 0) && a.flags.has('r') && sig && (sig.type === 'xfs' || sig.type === 'ext4')) {
    if (sig.type === 'xfs' && !mounted) {
      ctx.out(`  Logical volume ${name} successfully resized.\n`)
      ctx.err(`  [simulador] XFS solo se agranda montado: monta el volumen y ejecuta xfs_growfs.\n`)
      return 0
    }
    ctx.out(`  Extending file system ${sig.type} to ${lvmLong(newSize)} (${newSize} bytes) on ${name}...\n`)
    growFs(ctx, dev)
    ctx.out(`  Extended file system ${sig.type} on ${name}.\n`)
  }
  ctx.out(`  Logical volume ${name} successfully resized.\n`)
  return 0
}

register('lvextend', { usage: 'lvextend [-r] -L +TAMAÑO|-l +EXTENTS LV', path: '/usr/sbin', run: (ctx) => lvResize(ctx, 'extend') })
register('lvreduce', { usage: 'lvreduce [-r] -L TAMAÑO LV', path: '/usr/sbin', run: (ctx) => lvResize(ctx, 'reduce') })
register('lvresize', { usage: 'lvresize [-r] -L TAMAÑO LV', path: '/usr/sbin', run: (ctx) => lvResize(ctx, 'resize') })

register('lvremove', {
  usage: 'lvremove LV',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, LVM_DENIED)) return 5
    const s = st(ctx)
    const arg = ctx.args.find((x) => !x.startsWith('-')) ?? ''
    const t = lvTarget(s, arg)
    if (!t) {
      ctx.err(`  Failed to find logical volume "${arg}"\n`)
      return 5
    }
    const dev = s.lvPath(t.vg.name, t.lv.name)
    if (s.holder(dev)) {
      ctx.err(`  Logical volume ${t.vg.name}/${t.lv.name} contains a filesystem in use.\n`)
      return 5
    }
    if (!ctx.args.some((x) => x === '-y' || x === '-f') && !askYes(ctx, `Do you really want to remove active logical volume ${t.vg.name}/${t.lv.name}? [y/n]: `, { v: false })) return 5
    t.vg.lvs = t.vg.lvs.filter((l) => l !== t.lv)
    s.sigs.delete(dev)
    s.syncDevFiles()
    ctx.out(`  Logical volume "${t.lv.name}" successfully removed.\n`)
    return 0
  },
})

register('xfs_growfs', {
  usage: 'xfs_growfs CARPETA',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const arg = ctx.args.find((x) => !x.startsWith('-')) ?? ''
    if (needRoot(ctx, `xfs_growfs: ${arg}: Permission denied\n`)) return 1
    const dev = arg.startsWith('/dev/') ? s.canonical(arg) : s.mounts.find((m) => m.target === normalizePath(ctx.sh.resolve(arg)))?.dev
    const m = s.mounts.find((x) => x.dev === dev)
    if (!dev || !m || s.sigs.get(dev)?.type !== 'xfs') {
      ctx.err(`xfs_growfs: ${arg} is not a mounted XFS filesystem\n`)
      return 1
    }
    growFs(ctx, dev)
    return 0
  },
})

register('resize2fs', {
  usage: 'resize2fs DISPOSITIVO',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const arg = ctx.args.find((x) => !x.startsWith('-')) ?? ''
    if (needRoot(ctx, `resize2fs 1.47.1 (20-May-2024)\nopen: Permission denied while opening ${arg}\n`)) return 1
    const dev = s.canonical(arg)
    if (!dev || s.sigs.get(dev)?.type !== 'ext4') {
      ctx.err(`resize2fs 1.47.1 (20-May-2024)\nresize2fs: Bad magic number in super-block while trying to open ${arg}\nCouldn't find valid filesystem superblock.\n`)
      return 1
    }
    if (s.sigs.get(dev)!.size === s.size(dev)) {
      ctx.out(`resize2fs 1.47.1 (20-May-2024)\nThe filesystem is already ${Math.floor(s.size(dev)! / 4096)} (4k) blocks long.  Nothing to do!\n\n`)
      return 0
    }
    growFs(ctx, dev)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Archivos grandes: fallocate y dd
// ---------------------------------------------------------------------------------------

function createSized(ctx: CommandContext, path: string, size: number, prog: string): boolean {
  const s = st(ctx)
  const abs = ctx.sh.resolve(path)
  const dev = s.devOfPath(abs.slice(0, abs.lastIndexOf('/')) || '/')
  const sig = dev ? s.sigs.get(dev) : undefined
  let current = 0
  try {
    const n = ctx.sys.vfs.stat(abs, ROOT_CRED)
    current = n.size ?? n.data.length
  } catch {
    // archivo nuevo
  }
  if (sig && dev && s.used(dev) - current + size > sig.size) {
    ctx.err(prog === 'fallocate' ? `fallocate: fallocate failed: No space left on device\n` : `dd: error writing '${path}': No space left on device\n`)
    return false
  }
  try {
    ctx.sys.vfs.writeFile(abs, '', ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
    ctx.sys.vfs.stat(abs, ctx.sh.cred).size = size
  } catch (e) {
    ctx.err(`${prog}: cannot open '${path}': ${(e as Error).message}\n`)
    return false
  }
  return true
}

register('fallocate', {
  usage: 'fallocate -l TAMAÑO ARCHIVO',
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { l: ['l', 'length'] } })
    const size = parseSize(a.values.get('l') ?? '', 1)
    const file = a.rest[0]
    if (size === undefined || !file) {
      ctx.err('fallocate: no length argument specified\n')
      return 1
    }
    return createSized(ctx, file, size, 'fallocate') ? 0 : 1
  },
})

register('dd', {
  usage: 'dd if=ORIGEN of=DESTINO bs=TAMAÑO count=N',
  run(ctx) {
    const kv = Object.fromEntries(ctx.args.map((x) => x.split('=') as [string, string]))
    const bs = parseSize(kv.bs ?? '512', 1) ?? 512
    const count = Number(kv.count ?? 0)
    if (!kv.of) {
      ctx.err('[simulador] dd solo se simula escribiendo en un archivo: dd if=/dev/zero of=archivo bs=1M count=100\n')
      return 1
    }
    if (kv.of.startsWith('/dev/')) {
      ctx.err(`[simulador] Escribir con dd sobre un disco (${kv.of}) borra todo lo que tiene. Aquí no se simula: para limpiar firmas usa wipefs -a.\n`)
      return 1
    }
    if (!['/dev/zero', '/dev/urandom', '/dev/random'].includes(kv.if ?? '')) {
      ctx.err('[simulador] Como origen se simulan /dev/zero y /dev/urandom.\n')
      return 1
    }
    const total = bs * count
    if (!createSized(ctx, kv.of, total, 'dd')) return 1
    const secs = Math.max(0.05, total / (850 * 1e6))
    ctx.err(`${count}+0 records in\n${count}+0 records out\n${total} bytes (${dfHuman(total, true)}B, ${lsSize(total)}iB) copied, ${secs.toFixed(4)} s, ${dfHuman(total / secs, true)}B/s\n`.replace(/(\d)([KMGT])B/g, '$1 $2B').replace(/(\d)([KMGT])iB/g, '$1 $2iB'))
    return 0
  },
})

register('truncate', {
  usage: 'truncate -s TAMAÑO ARCHIVO...',
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { s: ['s', 'size'] } })
    const size = parseSize(a.values.get('s') ?? '', 1)
    if (size === undefined || !a.rest.length) {
      ctx.err("truncate: you must specify either '--size' or '--reference'\n")
      return 1
    }
    let code = 0
    for (const f of a.rest) {
      const abs = ctx.sh.resolve(f)
      try {
        if (!ctx.sys.vfs.exists(abs)) ctx.sys.vfs.writeFile(abs, '', ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
        const node = ctx.sys.vfs.stat(abs, ctx.sh.cred)
        if (!ctx.sys.vfs.can(node, ctx.sh.cred, 2)) throw new Error('Permission denied')
        node.data = size === 0 ? '' : node.data.slice(0, size)
        node.size = size === 0 ? undefined : size
      } catch (e) {
        ctx.err(`truncate: cannot open '${f}' for writing: ${(e as Error).message}\n`)
        code = 1
      }
    }
    return code
  },
})

register('sync', {
  usage: 'sync',
  run: () => 0,
})

// ---------------------------------------------------------------------------------------
// lsof: archivos abiertos (los borrados que todavía ocupan espacio)
// ---------------------------------------------------------------------------------------

register('lsof', {
  usage: 'lsof [+L1] [ARCHIVO|CARPETA]',
  summary: '  +L1   archivos borrados que un proceso todavía tiene abiertos',
  path: '/usr/sbin',
  run(ctx) {
    const s = st(ctx)
    const plusL = ctx.args.includes('+L1')
    const arg = ctx.args.find((x) => !x.startsWith('-') && !x.startsWith('+'))
    const head = 'COMMAND    PID   USER   FD   TYPE DEVICE   SIZE/OFF NLINK     NODE NAME\n'
    const rows: string[] = []
    const live = s.liveDeleted()
    const visible = ctx.sh.user === 'root' ? live : live.filter((d) => d.user === ctx.sh.user)
    for (const d of visible) {
      const m = s.mounts.find((x) => x.dev === d.dev)
      if (arg) {
        const abs = normalizePath(ctx.sh.resolve(arg))
        if (!(d.path === abs || d.path.startsWith(abs + '/') || m?.target === abs)) continue
      }
      const lvMinor = s.findLv(d.dev)?.lv.minor
      const device = lvMinor !== undefined ? `253,${lvMinor}` : '8,1'
      rows.push(`${d.command.slice(0, 9).padEnd(9)} ${String(d.pid).padStart(5)} ${d.user.padEnd(6)} ${'4w'.padStart(4)}   REG ${device.padStart(6)} ${String(d.size).padStart(10)}     0 ${String(33554000 + d.pid).padStart(8)} ${d.path} (deleted)`)
    }
    if (!plusL && !arg && !rows.length) {
      ctx.err('[simulador] lsof sin argumentos lista miles de archivos abiertos. Prueba lsof +L1 (archivos borrados que siguen abiertos) o lsof /carpeta.\n')
      return 1
    }
    if (!rows.length) return 1
    ctx.out(head + rows.join('\n') + '\n')
    return 0
  },
})
