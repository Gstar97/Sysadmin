/** Validación de /etc/fstab: seis campos, tipos de sistema de archivos y opciones habituales. */
import type { Diagnostic } from './types'

const FS_TYPES = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'ntfs-3g', 'swap', 'nfs', 'nfs4', 'cifs', 'smb3', 'tmpfs', 'iso9660', 'udf', 'auto', 'proc', 'sysfs', 'devpts', 'none', 'fuse.sshfs', 'zfs', 'overlay', 'bind'])

export function validateFstab(text: string): { entries: string[][]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const entries: string[][] = []
  const mountPoints = new Map<string, number>()
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (!t || t.startsWith('#')) return
    const f = t.split(/\s+/)
    entries.push(f)
    if (f.length < 4) {
      diagnostics.push({ line, severity: 'error', message: `La línea tiene ${f.length} campos: hacen falta al menos 4 (dispositivo, punto de montaje, tipo y opciones); lo habitual son 6.` })
      return
    }
    if (f.length > 6) diagnostics.push({ line, severity: 'error', message: `La línea tiene ${f.length} campos y fstab usa 6. Si una ruta tiene espacios, escríbelos como \\040.` })
    const [dev, mnt, type, opts, dump = '0', pass = '0'] = f
    if (!/^(UUID=|LABEL=|PARTUUID=|PARTLABEL=|\/dev\/|\/\/|[\w.-]+:\/|tmpfs$|proc$|sysfs$|devpts$|none$|\/)/.test(dev)) {
      diagnostics.push({ line, severity: 'error', message: `"${dev}" no parece un dispositivo válido. Formatos habituales: UUID=..., LABEL=..., /dev/sdb1, servidor:/exportación (NFS) o //servidor/recurso (CIFS).` })
    }
    if (/^UUID=/.test(dev) && !/^UUID=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9a-fA-F]{16})$/.test(dev)) {
      diagnostics.push({ line, severity: 'warning', message: 'El UUID no tiene el formato habitual: cópialo tal cual de "blkid" o "lsblk -f".' })
    }
    if (type !== 'swap' && mnt !== 'none' && !mnt.startsWith('/')) diagnostics.push({ line, severity: 'error', message: `El punto de montaje "${mnt}" tiene que ser una ruta absoluta (empezar con /).` })
    if (type === 'swap' && mnt !== 'none' && mnt !== 'swap') diagnostics.push({ line, severity: 'warning', message: 'Para swap, el punto de montaje se escribe "none".' })
    if (!FS_TYPES.has(type)) diagnostics.push({ line, severity: 'error', message: `Tipo de sistema de archivos desconocido: "${type}" (ejemplos: ext4, xfs, btrfs, vfat, nfs, cifs, swap).` })
    if (!opts || opts.endsWith(',') || opts.startsWith(',') || opts.includes(',,')) diagnostics.push({ line, severity: 'error', message: 'Las opciones van separadas por comas, sin espacios ni comas sobrantes (por ejemplo: defaults,noatime).' })
    if (!/^[01]$/.test(dump)) diagnostics.push({ line, severity: 'error', message: 'El quinto campo (dump) es 0 o 1; casi siempre 0.' })
    if (!/^[012]$/.test(pass)) diagnostics.push({ line, severity: 'error', message: 'El sexto campo (orden de fsck) es 0, 1 o 2.' })
    if (mnt === '/' && pass !== '1' && !['xfs', 'btrfs'].includes(type)) diagnostics.push({ line, severity: 'warning', message: 'La raíz (/) normalmente lleva 1 en el sexto campo para que fsck la revise primero.' })
    if (mnt !== '/' && pass === '1') diagnostics.push({ line, severity: 'warning', message: 'Solo la raíz (/) debería llevar 1 en el sexto campo; el resto usa 2 (o 0 si no se revisa).' })
    if ((type === 'swap' || ['nfs', 'nfs4', 'cifs', 'smb3', 'tmpfs', 'proc'].includes(type)) && pass !== '0') diagnostics.push({ line, severity: 'warning', message: `Para ${type}, el sexto campo va en 0: fsck no revisa este tipo.` })
    if (['nfs', 'nfs4', 'cifs', 'smb3'].includes(type) && !/(_netdev|nofail)/.test(opts)) diagnostics.push({ line, severity: 'warning', message: 'En montajes de red conviene agregar "_netdev" (y "nofail") para que el arranque no se trabe si el servidor no responde.' })
    if (/^\/dev\/sd[a-z]\d*$/.test(dev)) diagnostics.push({ line, severity: 'warning', message: `"${dev}" puede cambiar de nombre entre reinicios: es más seguro usar UUID=...` })
    if (mountPoints.has(mnt) && mnt !== 'none') diagnostics.push({ line, severity: 'error', message: `El punto de montaje ${mnt} ya se usa en la línea ${mountPoints.get(mnt)}.` })
    else mountPoints.set(mnt, line)
  })
  return { entries, diagnostics }
}
