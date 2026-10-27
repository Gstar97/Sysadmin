import type { CommandContext } from '../shell'
import { FsError, type Inode } from '../vfs'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Fecha en formato ls -l: "Oct 27 12:34" (reciente) u "Oct 27  2025" (antigua). */
export function lsDate(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const month = MONTHS[d.getMonth()]
  const day = String(d.getDate()).padStart(2)
  const recent = now - ms < 180 * 86_400_000
  return recent
    ? `${month} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${month} ${day}  ${d.getFullYear()}`
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes)
  const units = ['K', 'M', 'G', 'T']
  let v = bytes
  let i = -1
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v)).toString() + units[i]
}

export function sizeOf(node: Inode): number {
  if (node.type === 'dir') return 4096
  if (node.type === 'symlink') return node.data.length
  return new TextEncoder().encode(node.data).length
}

/** Muestra un error de archivo con el formato de coreutils: "cmd: cannot X 'path': motivo". */
export function fsErr(ctx: CommandContext, e: unknown, action: string, path: string): number {
  if (e instanceof FsError) {
    ctx.err(`${ctx.name}: ${action ? `${action} ` : ''}'${path}': ${e.message}\n`)
    return 1
  }
  throw e
}

export function readInputs(ctx: CommandContext, files: string[]): { name: string; data: string }[] | number {
  if (files.length === 0 || (files.length === 1 && files[0] === '-')) return [{ name: '-', data: ctx.stdin.readAll() }]
  const out: { name: string; data: string }[] = []
  let failed = false
  for (const f of files) {
    if (f === '-') {
      out.push({ name: '-', data: ctx.stdin.readAll() })
      continue
    }
    try {
      out.push({ name: f, data: ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred) })
    } catch (e) {
      if (e instanceof FsError) {
        ctx.err(`${ctx.name}: ${f}: ${e.message}\n`)
        failed = true
      } else throw e
    }
  }
  return failed && out.length === 0 ? 1 : out
}

export function lines(data: string): string[] {
  if (!data) return []
  const ls = data.split('\n')
  if (ls[ls.length - 1] === '') ls.pop()
  return ls
}

export const COLOR = {
  dir: '\x1b[01;34m',
  link: '\x1b[01;36m',
  exec: '\x1b[01;32m',
  sticky: '\x1b[30;42m',
  match: '\x1b[01;31m',
  reset: '\x1b[0m',
}

/** Calcula el modo resultante de chmod (simbólico u octal). */
export function applyChmod(spec: string, current: number, isDir: boolean, umask = 0o022): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) {
    const n = parseInt(spec, 8)
    // chmod con 3 dígitos en un directorio conserva SUID/SGID (comportamiento de GNU).
    return spec.length <= 3 && isDir ? (current & 0o6000) | n : n
  }
  let mode = current
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause)
    if (!m) return null
    const who = m[1] || 'a'
    const op = m[2]
    const perms = m[3]
    let bits = 0
    const masks: number[] = []
    for (const w of who === 'a' ? 'ugo' : who) masks.push(w === 'u' ? 6 : w === 'g' ? 3 : 0)
    const fromOther = /^[ugo]$/.test(perms)
    for (const shift of masks) {
      if (fromOther) {
        const src = perms === 'u' ? 6 : perms === 'g' ? 3 : 0
        bits |= ((current >> src) & 7) << shift
        continue
      }
      for (const p of perms) {
        if (p === 'r') bits |= 4 << shift
        if (p === 'w') bits |= 2 << shift
        if (p === 'x') bits |= 1 << shift
        if (p === 'X' && (isDir || current & 0o111)) bits |= 1 << shift
        if (p === 's' && shift === 6) bits |= 0o4000
        if (p === 's' && shift === 3) bits |= 0o2000
        if (p === 't') bits |= 0o1000
      }
    }
    if (!m[1] && op !== '=') bits &= ~umask | 0o7000
    if (op === '+') mode |= bits
    else if (op === '-') mode &= ~bits
    else {
      let clear = 0
      for (const shift of masks) clear |= 7 << shift
      if (masks.includes(6)) clear |= 0o4000
      if (masks.includes(3)) clear |= 0o2000
      mode = (mode & ~clear) | bits
    }
  }
  return mode & 0o7777
}
