/**
 * Sistema de archivos virtual con inodos, dueños, grupos, permisos (incluidos SUID, SGID y
 * sticky) y enlaces duros y simbólicos. Los permisos se aplican igual que en Linux.
 */

export type FileType = 'file' | 'dir' | 'symlink'

export interface Inode {
  ino: number
  type: FileType
  /** Bits de permiso, incluidos los especiales (por ejemplo 0o2770). */
  mode: number
  uid: number
  gid: number
  mtime: number
  /** Contenido del archivo o destino del enlace simbólico. */
  data: string
  /** Tamaño aparente de los ejecutables simulados (su contenido real es solo la cabecera). */
  size?: number
  entries?: Map<string, number>
  nlink: number
}

export interface Cred {
  uid: number
  gid: number
  groups: number[]
}

export type FsErrorCode = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EACCES' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP' | 'EPERM' | 'EINVAL' | 'EXDEV'

const MESSAGES: Record<FsErrorCode, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EPERM: 'Operation not permitted',
  EINVAL: 'Invalid argument',
  EXDEV: 'Invalid cross-device link',
}

export class FsError extends Error {
  constructor(
    public code: FsErrorCode,
    public path: string,
  ) {
    super(MESSAGES[code])
  }
}

export const ROOT_CRED: Cred = { uid: 0, gid: 0, groups: [0] }

export function normalizePath(path: string, cwd = '/'): string {
  const abs = path.startsWith('/') ? path : `${cwd}/${path}`
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return '/' + parts.join('/')
}

export function dirname(path: string): string {
  const n = normalizePath(path)
  if (n === '/') return '/'
  return n.slice(0, n.lastIndexOf('/')) || '/'
}

export function basename(path: string): string {
  const n = normalizePath(path)
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1)
}

export class VFS {
  inodes = new Map<number, Inode>()
  private nextIno = 2
  readonly root = 1
  /** Hora de referencia para las fechas de modificación. */
  now: () => number = () => Date.now()

  constructor() {
    this.inodes.set(1, { ino: 1, type: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: Date.now(), data: '', entries: new Map(), nlink: 2 })
  }

  get(ino: number): Inode {
    const node = this.inodes.get(ino)
    if (!node) throw new FsError('ENOENT', String(ino))
    return node
  }

  // ---------------------------------------------------------------------------
  // Permisos
  // ---------------------------------------------------------------------------

  /** Comprueba un permiso (4 = lectura, 2 = escritura, 1 = ejecución/búsqueda). */
  can(node: Inode, cred: Cred, want: 4 | 2 | 1): boolean {
    if (cred.uid === 0) {
      if (want !== 1 || node.type === 'dir') return true
      return (node.mode & 0o111) !== 0
    }
    let bits: number
    if (cred.uid === node.uid) bits = (node.mode >> 6) & 7
    else if (cred.gid === node.gid || cred.groups.includes(node.gid)) bits = (node.mode >> 3) & 7
    else bits = node.mode & 7
    return (bits & want) !== 0
  }

  // ---------------------------------------------------------------------------
  // Resolución de rutas
  // ---------------------------------------------------------------------------

  /** Devuelve el inodo de una ruta absoluta. follow=false no sigue el último enlace simbólico. */
  resolve(path: string, cred: Cred, follow = true, depth = 0): number {
    if (depth > 20) throw new FsError('ELOOP', path)
    const abs = normalizePath(path)
    let current = this.root
    const parts = abs.split('/').filter(Boolean)
    let walked = ''
    for (let i = 0; i < parts.length; i++) {
      const node = this.get(current)
      if (node.type !== 'dir') throw new FsError('ENOTDIR', path)
      if (!this.can(node, cred, 1)) throw new FsError('EACCES', path)
      const next = node.entries!.get(parts[i])
      if (next === undefined) throw new FsError('ENOENT', path)
      const child = this.get(next)
      const isLast = i === parts.length - 1
      if (child.type === 'symlink' && (!isLast || follow)) {
        const target = child.data.startsWith('/') ? child.data : `${walked || ''}/${child.data}`
        const rest = parts.slice(i + 1).join('/')
        return this.resolve(normalizePath(rest ? `${target}/${rest}` : target), cred, follow, depth + 1)
      }
      walked += '/' + parts[i]
      current = next
    }
    return current
  }

  exists(path: string, cred: Cred = ROOT_CRED, follow = true): boolean {
    try {
      this.resolve(path, cred, follow)
      return true
    } catch {
      return false
    }
  }

  stat(path: string, cred: Cred, follow = true): Inode {
    return this.get(this.resolve(path, cred, follow))
  }

  /** Directorio padre (con permiso de escritura y búsqueda) y nombre final. */
  private parentFor(path: string, cred: Cred, needWrite = true): { parent: Inode; name: string } {
    const abs = normalizePath(path)
    if (abs === '/') throw new FsError('EEXIST', path)
    const parent = this.get(this.resolve(dirname(abs), cred))
    if (parent.type !== 'dir') throw new FsError('ENOTDIR', path)
    if (needWrite && (!this.can(parent, cred, 2) || !this.can(parent, cred, 1))) throw new FsError('EACCES', path)
    return { parent, name: basename(abs) }
  }

  private newInode(type: FileType, mode: number, cred: Cred, parent?: Inode): Inode {
    // SGID en el directorio padre: el archivo hereda el grupo (y los subdirectorios, el bit).
    const inheritGroup = parent && (parent.mode & 0o2000) !== 0
    const gid = inheritGroup ? parent!.gid : cred.gid
    let finalMode = mode
    if (type === 'dir' && inheritGroup) finalMode |= 0o2000
    const node: Inode = {
      ino: this.nextIno++,
      type,
      mode: finalMode,
      uid: cred.uid,
      gid,
      mtime: this.now(),
      data: '',
      nlink: type === 'dir' ? 2 : 1,
      entries: type === 'dir' ? new Map() : undefined,
    }
    this.inodes.set(node.ino, node)
    return node
  }

  // ---------------------------------------------------------------------------
  // Operaciones
  // ---------------------------------------------------------------------------

  readdir(path: string, cred: Cred): string[] {
    const node = this.stat(path, cred)
    if (node.type !== 'dir') throw new FsError('ENOTDIR', path)
    if (!this.can(node, cred, 4)) throw new FsError('EACCES', path)
    return [...node.entries!.keys()].sort((a, b) => a.localeCompare(b, 'en'))
  }

  readFile(path: string, cred: Cred): string {
    const node = this.stat(path, cred)
    if (node.type === 'dir') throw new FsError('EISDIR', path)
    if (!this.can(node, cred, 4)) throw new FsError('EACCES', path)
    return node.data
  }

  writeFile(path: string, data: string, cred: Cred, opts: { append?: boolean; mode?: number } = {}): void {
    const abs = normalizePath(path)
    let ino: number | undefined
    try {
      ino = this.resolve(abs, cred)
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== 'ENOENT') throw e
    }
    if (ino !== undefined) {
      const node = this.get(ino)
      if (node.type === 'dir') throw new FsError('EISDIR', path)
      if (!this.can(node, cred, 2)) throw new FsError('EACCES', path)
      node.data = opts.append ? node.data + data : data
      node.size = undefined
      node.mtime = this.now()
      return
    }
    const { parent, name } = this.parentFor(abs, cred)
    const node = this.newInode('file', opts.mode ?? 0o644, cred, parent)
    node.data = data
    parent.entries!.set(name, node.ino)
    parent.mtime = this.now()
  }

  touch(path: string, cred: Cred): void {
    if (this.exists(path, cred)) {
      const node = this.stat(path, cred)
      if (cred.uid !== 0 && cred.uid !== node.uid && !this.can(node, cred, 2)) throw new FsError('EACCES', path)
      node.mtime = this.now()
    } else {
      this.writeFile(path, '', cred)
    }
  }

  mkdir(path: string, cred: Cred, mode = 0o755): void {
    const abs = normalizePath(path)
    if (this.exists(abs, cred, false)) throw new FsError('EEXIST', path)
    const { parent, name } = this.parentFor(abs, cred)
    const node = this.newInode('dir', mode, cred, parent)
    parent.entries!.set(name, node.ino)
    parent.nlink++
    parent.mtime = this.now()
  }

  mkdirp(path: string, cred: Cred, mode = 0o755): void {
    const abs = normalizePath(path)
    let acc = ''
    for (const part of abs.split('/').filter(Boolean)) {
      acc += '/' + part
      if (!this.exists(acc, cred)) this.mkdir(acc, cred, mode)
      else if (this.stat(acc, cred).type !== 'dir') throw new FsError('ENOTDIR', acc)
    }
  }

  private checkSticky(parent: Inode, child: Inode, cred: Cred, path: string) {
    if ((parent.mode & 0o1000) !== 0 && cred.uid !== 0 && cred.uid !== child.uid && cred.uid !== parent.uid) {
      throw new FsError('EACCES', path)
    }
  }

  unlink(path: string, cred: Cred): void {
    const { parent, name } = this.parentFor(path, cred)
    const ino = parent.entries!.get(name)
    if (ino === undefined) throw new FsError('ENOENT', path)
    const child = this.get(ino)
    if (child.type === 'dir') throw new FsError('EISDIR', path)
    this.checkSticky(parent, child, cred, path)
    parent.entries!.delete(name)
    parent.mtime = this.now()
    child.nlink--
    if (child.nlink <= 0) this.inodes.delete(ino)
  }

  rmdir(path: string, cred: Cred): void {
    const { parent, name } = this.parentFor(path, cred)
    const ino = parent.entries!.get(name)
    if (ino === undefined) throw new FsError('ENOENT', path)
    const child = this.get(ino)
    if (child.type !== 'dir') throw new FsError('ENOTDIR', path)
    if (child.entries!.size > 0) throw new FsError('ENOTEMPTY', path)
    this.checkSticky(parent, child, cred, path)
    parent.entries!.delete(name)
    parent.nlink--
    this.inodes.delete(ino)
  }

  /** Borra recursivamente (rm -r). */
  removeTree(path: string, cred: Cred): void {
    const node = this.stat(path, cred, false)
    if (node.type === 'dir') {
      if (!this.can(node, cred, 4) || !this.can(node, cred, 2) || !this.can(node, cred, 1)) throw new FsError('EACCES', path)
      for (const name of [...node.entries!.keys()]) this.removeTree(`${normalizePath(path)}/${name}`, cred)
      this.rmdir(path, cred)
    } else {
      this.unlink(path, cred)
    }
  }

  symlink(target: string, path: string, cred: Cred): void {
    if (this.exists(path, cred, false)) throw new FsError('EEXIST', path)
    const { parent, name } = this.parentFor(path, cred)
    const node = this.newInode('symlink', 0o777, cred, parent)
    node.data = target
    parent.entries!.set(name, node.ino)
  }

  link(existing: string, path: string, cred: Cred): void {
    const src = this.stat(existing, cred)
    if (src.type === 'dir') throw new FsError('EPERM', existing)
    if (this.exists(path, cred, false)) throw new FsError('EEXIST', path)
    const { parent, name } = this.parentFor(path, cred)
    parent.entries!.set(name, src.ino)
    src.nlink++
  }

  rename(from: string, to: string, cred: Cred): void {
    const src = this.parentFor(from, cred)
    const ino = src.parent.entries!.get(src.name)
    if (ino === undefined) throw new FsError('ENOENT', from)
    const child = this.get(ino)
    this.checkSticky(src.parent, child, cred, from)
    let dest = normalizePath(to)
    if (this.exists(dest, cred) && this.stat(dest, cred).type === 'dir') dest = `${dest}/${src.name}`
    if (child.type === 'dir' && (dest + '/').startsWith(normalizePath(from) + '/')) throw new FsError('EINVAL', to)
    const dst = this.parentFor(dest, cred)
    const existing = dst.parent.entries!.get(dst.name)
    if (existing !== undefined) {
      const ex = this.get(existing)
      if (ex.type === 'dir') {
        if (ex.entries!.size) throw new FsError('ENOTEMPTY', to)
        this.inodes.delete(existing)
      } else {
        ex.nlink--
        if (ex.nlink <= 0) this.inodes.delete(existing)
      }
    }
    src.parent.entries!.delete(src.name)
    dst.parent.entries!.set(dst.name, ino)
    if (child.type === 'dir' && src.parent !== dst.parent) {
      src.parent.nlink--
      dst.parent.nlink++
    }
  }

  chmod(path: string, mode: number, cred: Cred): void {
    const node = this.stat(path, cred)
    if (cred.uid !== 0 && cred.uid !== node.uid) throw new FsError('EPERM', path)
    node.mode = mode & 0o7777
  }

  chown(path: string, uid: number | undefined, gid: number | undefined, cred: Cred, follow = true): void {
    const node = this.stat(path, cred, follow)
    if (cred.uid !== 0) {
      if (uid !== undefined && uid !== node.uid) throw new FsError('EPERM', path)
      if (gid !== undefined && (cred.uid !== node.uid || !(cred.groups.includes(gid) || cred.gid === gid))) {
        throw new FsError('EPERM', path)
      }
    }
    if (uid !== undefined) node.uid = uid
    if (gid !== undefined) node.gid = gid
    // Cambiar el dueño quita SUID/SGID de los archivos, como en Linux.
    if (node.type === 'file' && uid !== undefined) node.mode &= ~0o6000
  }

  /** Copia un archivo o, con recursive, un directorio completo. */
  copy(from: string, to: string, cred: Cred, opts: { recursive?: boolean; preserve?: boolean } = {}): void {
    const src = this.stat(from, cred)
    let dest = normalizePath(to)
    if (this.exists(dest, cred) && this.stat(dest, cred).type === 'dir') dest = `${dest}/${basename(from)}`
    if (src.type === 'dir') {
      if (!opts.recursive) throw new FsError('EISDIR', from)
      if (!this.can(src, cred, 4)) throw new FsError('EACCES', from)
      if (!this.exists(dest, cred)) this.mkdir(dest, cred, src.mode & 0o7777)
      for (const name of src.entries!.keys()) this.copy(`${normalizePath(from)}/${name}`, `${dest}/${name}`, cred, opts)
      if (opts.preserve) this.applyMeta(dest, src, cred)
      return
    }
    const data = this.readFile(from, cred)
    const existed = this.exists(dest, cred)
    this.writeFile(dest, data, cred, { mode: src.mode & 0o777 })
    if (!existed && !opts.preserve) {
      const node = this.stat(dest, cred)
      node.mode = src.mode & 0o777
    }
    if (opts.preserve) this.applyMeta(dest, src, cred)
  }

  private applyMeta(dest: string, src: Inode, cred: Cred) {
    const node = this.stat(dest, cred)
    node.mode = src.mode
    node.mtime = src.mtime
    if (cred.uid === 0) {
      node.uid = src.uid
      node.gid = src.gid
    }
  }

  /** Recorre un árbol desde una ruta (para find, du, ls -R). */
  walk(
    path: string,
    cred: Cred,
    visit: (abs: string, node: Inode, depth: number) => boolean | void,
    onError?: (abs: string, error: FsError) => void,
    depth = 0,
  ): void {
    const abs = normalizePath(path)
    const node = this.stat(abs, cred, false)
    const descend = visit(abs, node, depth)
    if (node.type !== 'dir' || descend === false) return
    if (!this.can(node, cred, 4) || !this.can(node, cred, 1)) {
      const err = new FsError('EACCES', abs)
      if (onError) return onError(abs, err)
      throw err
    }
    for (const name of [...node.entries!.keys()].sort()) {
      this.walk(abs === '/' ? `/${name}` : `${abs}/${name}`, cred, visit, onError, depth + 1)
    }
  }
}

/** Convierte permisos numéricos en el formato de ls -l (por ejemplo drwxr-sr-x). */
export function modeString(node: Pick<Inode, 'type' | 'mode'>): string {
  const t = node.type === 'dir' ? 'd' : node.type === 'symlink' ? 'l' : '-'
  const m = node.mode
  const tri = (shift: number, special: number, ch: string) => {
    const r = m & (4 << shift) ? 'r' : '-'
    const w = m & (2 << shift) ? 'w' : '-'
    const x = m & (1 << shift)
    const s = m & special
    const xs = s ? (x ? ch : ch.toUpperCase()) : x ? 'x' : '-'
    return r + w + xs
  }
  return t + tri(6, 0o4000, 's') + tri(3, 0o2000, 's') + tri(0, 0o1000, 't')
}

export function octal(mode: number, width = 4): string {
  return (mode & 0o7777).toString(8).padStart(width, '0')
}
