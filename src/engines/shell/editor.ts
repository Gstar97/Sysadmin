/** Guardado del editor de texto de la terminal (nano, vim, crontab -e, visudo, systemctl edit). */
import { checkSudoers } from './commands/users'
import type { EditorRequest, Shell } from './shell'
import { FsError, ROOT_CRED } from './vfs'

export interface SaveResult {
  ok: boolean
  /** Mensaje que se muestra en la terminal al cerrar el editor o dentro del editor si falló. */
  message?: string
}

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
const CRON_NAMES = /^(@reboot|@yearly|@annually|@monthly|@weekly|@daily|@midnight|@hourly)$/

/** Devuelve el número de línea con error de un crontab, o null si está bien. */
export function checkCrontab(text: string): { line: number; message: string } | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('#') || /^[A-Z_]+=/.test(l)) continue
    const parts = l.split(/\s+/)
    if (CRON_NAMES.test(parts[0])) {
      if (parts.length < 2) return { line: i + 1, message: 'bad command' }
      continue
    }
    if (parts.length < 6) return { line: i + 1, message: parts.length < 5 ? 'premature EOF' : 'bad command' }
    const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']
    const max = [59, 23, 31, 12, 7]
    for (let f = 0; f < 5; f++) {
      const field = parts[f].toLowerCase().replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\b/g, '1')
      if (!CRON_FIELD.test(field) || (field.match(/\d+/g) ?? []).some((n) => Number(n) > max[f] && !field.includes('/'))) {
        return { line: i + 1, message: `bad ${names[f]}` }
      }
    }
  }
  return null
}

export function saveEditor(sh: Shell, req: EditorRequest, content: string): SaveResult {
  const vfs = sh.sys.vfs
  const text = content.endsWith('\n') || content === '' ? content : `${content}\n`
  if (req.editor === 'visudo') {
    const bad = checkSudoers(text)
    if (bad) return { ok: false, message: `>>> ${req.path}: syntax error near line ${bad} <<<\n[simulador] visudo no guarda un sudoers con errores: corrígelo o descarta los cambios.` }
    vfs.writeFile(req.path, text, ROOT_CRED, { mode: 0o440 })
    return { ok: true }
  }
  if (req.editor === 'crontab') {
    const bad = checkCrontab(text)
    if (bad) return { ok: false, message: `"/tmp/crontab.XXXXXX":${bad.line}: ${bad.message}\nerrors in crontab file, can't install.` }
    vfs.writeFile(req.path, text, ROOT_CRED)
    return { ok: true, message: 'crontab: installing new crontab' }
  }
  if (req.editor === 'systemctl edit') {
    vfs.writeFile(req.path, text, ROOT_CRED)
    return { ok: true }
  }
  try {
    vfs.writeFile(req.path, text, sh.cred)
    return { ok: true }
  } catch (e) {
    if (e instanceof FsError) {
      const reason = e.code === 'EACCES' ? 'Permission denied' : e.code === 'ENOENT' ? 'No such file or directory' : e.message
      return { ok: false, message: `[ Error writing ${req.path}: ${reason} ]` }
    }
    throw e
  }
}
