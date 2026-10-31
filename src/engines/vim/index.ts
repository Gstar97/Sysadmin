/**
 * Simulador de vim: buffer, modos (normal, inserción, línea de comandos y búsqueda) y los
 * comandos que se enseñan en el Nivel 1. Es lógica pura: cada tecla devuelve un estado nuevo.
 */

export type VimMode = 'normal' | 'insert' | 'command' | 'search'

interface Snapshot {
  lines: string[]
  row: number
  col: number
}

export interface VimState {
  filename: string
  lines: string[]
  row: number
  col: number
  mode: VimMode
  /** Texto que se escribe en la línea de comandos (después de : o /). */
  cmdline: string
  /** Teclas de un comando del modo normal que todavía no está completo (d, g, 3, r...). */
  pending: string
  register: { text: string[]; linewise: boolean } | null
  undo: Snapshot[]
  redo: Snapshot[]
  lastSearch?: string
  /** Mensaje de la última línea (errores o confirmaciones). */
  message: string
  messageIsError: boolean
  /** Contenido guardado en disco por última vez. */
  saved: string[]
  /** Cantidad de veces que se guardó el archivo. */
  writes: number
  quit: boolean
  numbers: boolean
  /** Comandos completos ejecutados (dd, 3x, :wq, /puerto...), para verificar ejercicios. */
  log: string[]
}

export function createVim(text: string, filename = 'archivo.txt'): VimState {
  const lines = text.replace(/\n$/, '').split('\n')
  return {
    filename,
    lines,
    row: 0,
    col: 0,
    mode: 'normal',
    cmdline: '',
    pending: '',
    register: null,
    undo: [],
    redo: [],
    message: `"${filename}" ${lines.length}L, ${text.length}B`,
    messageIsError: false,
    saved: [...lines],
    writes: 0,
    quit: false,
    numbers: false,
    log: [],
  }
}

export const isModified = (s: VimState) => s.lines.join('\n') !== s.saved.join('\n')
export const vimText = (s: VimState) => s.lines.join('\n') + '\n'

/** Convierte "dd:wq<CR>" en teclas: <Esc>, <CR>, <BS>, <C-r>, <Up>... */
export function parseKeys(s: string): string[] {
  const out: string[] = []
  const names: Record<string, string> = { esc: 'Escape', cr: 'Enter', enter: 'Enter', bs: 'Backspace', 'c-r': 'C-r', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ', lt: '<' }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') {
      const end = s.indexOf('>', i)
      const name = end > i ? names[s.slice(i + 1, end).toLowerCase()] : undefined
      if (name) {
        out.push(name)
        i = end
        continue
      }
    }
    out.push(s[i])
  }
  return out
}

export function vimKeys(state: VimState, keys: string | string[]): VimState {
  let s = state
  for (const k of typeof keys === 'string' ? parseKeys(keys) : keys) s = vimKey(s, k)
  return s
}

const clone = (s: VimState): VimState => ({ ...s, lines: [...s.lines], undo: [...s.undo], redo: [...s.redo], log: [...s.log] })
const snap = (s: VimState): Snapshot => ({ lines: [...s.lines], row: s.row, col: s.col })
function remember(s: VimState) {
  s.undo.push(snap(s))
  if (s.undo.length > 200) s.undo.shift()
  s.redo = []
}
const lineLen = (s: VimState, r = s.row) => s.lines[r]?.length ?? 0
function clampNormal(s: VimState) {
  s.row = Math.max(0, Math.min(s.row, s.lines.length - 1))
  s.col = Math.max(0, Math.min(s.col, Math.max(0, lineLen(s) - 1)))
}
const setMsg = (s: VimState, text: string, error = false) => {
  s.message = text
  s.messageIsError = error
}

const isWord = (c: string | undefined) => !!c && /[\wáéíóúñÁÉÍÓÚÑ]/.test(c)
const cls = (c: string | undefined) => (c === undefined || /\s/.test(c) ? 0 : isWord(c) ? 1 : 2)

/** Posición del comienzo de la palabra siguiente (w), recorriendo líneas. */
function nextWord(s: VimState, row: number, col: number): [number, number] {
  let r = row
  let c = col
  const line = () => s.lines[r] ?? ''
  const start = cls(line()[c])
  if (start !== 0) while (c < line().length && cls(line()[c]) === start) c++
  for (;;) {
    while (c < line().length && cls(line()[c]) === 0) c++
    if (c < line().length) return [r, c]
    if (r >= s.lines.length - 1) return [r, Math.max(0, line().length - 1)]
    r++
    c = 0
    if (line().length === 0) return [r, 0]
  }
}

function prevWord(s: VimState, row: number, col: number): [number, number] {
  let r = row
  let c = col - 1
  for (;;) {
    const line = s.lines[r] ?? ''
    while (c >= 0 && cls(line[c]) === 0) c--
    if (c >= 0) {
      const k = cls(line[c])
      while (c > 0 && cls(line[c - 1]) === k) c--
      return [r, c]
    }
    if (r === 0) return [0, 0]
    r--
    c = (s.lines[r] ?? '').length - 1
  }
}

function endWord(s: VimState, row: number, col: number): [number, number] {
  let r = row
  let c = col + 1
  for (;;) {
    const line = s.lines[r] ?? ''
    while (c < line.length && cls(line[c]) === 0) c++
    if (c < line.length) {
      const k = cls(line[c])
      while (c + 1 < line.length && cls(line[c + 1]) === k) c++
      return [r, c]
    }
    if (r >= s.lines.length - 1) return [r, Math.max(0, line.length - 1)]
    r++
    c = 0
  }
}

function toRegex(pattern: string, flags = ''): RegExp | null {
  // vim usa \< y \> para límites de palabra; el resto se aproxima con expresiones de JavaScript.
  const p = pattern.replace(/\\<|\\>/g, '\\b')
  try {
    return new RegExp(p, flags)
  } catch {
    try {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    } catch {
      return null
    }
  }
}

function search(s: VimState, pattern: string, forward: boolean): boolean {
  const re = toRegex(pattern)
  if (!re || !pattern) return false
  const n = s.lines.length
  for (let i = 0; i <= n; i++) {
    const r = forward ? (s.row + i) % n : (s.row - i + n) % n
    const line = s.lines[r]
    const hits: number[] = []
    const g = toRegex(pattern, 'g')!
    let m: RegExpExecArray | null
    while ((m = g.exec(line)) !== null) {
      hits.push(m.index)
      if (m[0] === '') g.lastIndex++
    }
    const candidates = i === 0 ? hits.filter((c) => (forward ? c > s.col : c < s.col)) : hits
    if (i === n && hits.length === 0) break
    if (candidates.length) {
      const col = forward ? candidates[0] : candidates[candidates.length - 1]
      const wrapped = forward ? r < s.row || (r === s.row && i > 0) : r > s.row || (r === s.row && i > 0)
      s.row = r
      s.col = col
      setMsg(s, wrapped ? (forward ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM') : `${forward ? '/' : '?'}${pattern}`)
      return true
    }
  }
  setMsg(s, `E486: Pattern not found: ${pattern}`, true)
  return false
}

function runCommand(s: VimState, raw: string) {
  const cmd = raw.trim()
  s.log.push(`:${cmd}`)
  const write = () => {
    s.saved = [...s.lines]
    s.writes++
    const bytes = vimText(s).length
    setMsg(s, `"${s.filename}" ${s.lines.length}L, ${bytes}B written`)
  }
  if (/^\d+$/.test(cmd)) {
    s.row = Math.min(Number(cmd), s.lines.length) - 1
    s.col = 0
    clampNormal(s)
    return
  }
  const sub = /^(%|\d+(?:,\d+)?)?s\/((?:\\\/|[^/])*)\/((?:\\\/|[^/])*)(?:\/([gi]*))?$/.exec(cmd)
  if (sub) {
    const [, range, pat, rep, flags = ''] = sub
    const re = toRegex(pat.replace(/\\\//g, '/'), (flags.includes('g') ? 'g' : '') + (flags.includes('i') ? 'i' : ''))
    if (!re) return setMsg(s, `E486: Pattern not found: ${pat}`, true)
    let from = s.row
    let to = s.row
    if (range === '%') [from, to] = [0, s.lines.length - 1]
    else if (range) {
      const [a, b] = range.split(',').map((x) => Number(x) - 1)
      ;[from, to] = [a, b ?? a]
    }
    let count = 0
    let changedLines = 0
    let lastRow = -1
    const before = snap(s)
    for (let r = from; r <= to && r < s.lines.length; r++) {
      const replaced = s.lines[r].replace(re, rep.replace(/\\\//g, '/').replace(/&/g, '$&'))
      if (replaced !== s.lines[r]) {
        count += flags.includes('g') ? (s.lines[r].match(new RegExp(re.source, 'g' + (flags.includes('i') ? 'i' : ''))) ?? []).length : 1
        s.lines[r] = replaced
        changedLines++
        lastRow = r
      }
    }
    if (!count) return setMsg(s, `E486: Pattern not found: ${pat}`, true)
    s.undo.push(before)
    s.redo = []
    s.row = lastRow
    s.col = 0
    setMsg(s, count > 1 ? `${count} substitutions on ${changedLines} line${changedLines > 1 ? 's' : ''}` : '')
    return
  }
  switch (cmd) {
    case 'w':
    case 'w!':
      return write()
    case 'wq':
    case 'wq!':
    case 'x':
    case 'x!':
      if (cmd.startsWith('x') && !isModified(s)) {
        s.quit = true
        return
      }
      write()
      s.quit = true
      return
    case 'q':
      if (isModified(s)) return setMsg(s, 'E37: No write since last change (add ! to override)', true)
      s.quit = true
      return
    case 'q!':
      s.quit = true
      return
    case 'e!':
      s.lines = [...s.saved]
      clampNormal(s)
      return setMsg(s, `"${s.filename}" ${s.lines.length}L`)
    case 'set nu':
    case 'set number':
      s.numbers = true
      return setMsg(s, '')
    case 'set nonu':
    case 'set nonumber':
      s.numbers = false
      return setMsg(s, '')
    case 'noh':
    case 'nohlsearch':
    case '':
      return setMsg(s, '')
    default:
      return setMsg(s, `E492: Not an editor command: ${cmd}`, true)
  }
}

function deleteLines(s: VimState, count: number, keep = true) {
  const n = Math.min(count, s.lines.length - s.row)
  const removed = s.lines.splice(s.row, n)
  if (keep) s.register = { text: removed, linewise: true }
  if (s.lines.length === 0) s.lines = ['']
  if (n >= 3) setMsg(s, `${n} fewer lines`)
  clampNormal(s)
  s.col = Math.min(s.col, Math.max(0, lineLen(s) - 1))
}

function normalKey(s: VimState, key: string) {
  // Las cifras forman un contador (3dd, 5j); un 0 sin contador va al principio de la línea.
  if (/^\d$/.test(key) && /^\d*$/.test(s.pending) && !(key === '0' && s.pending === '')) {
    s.pending += key
    return
  }
  if (key === '0' && s.pending === '') {
    s.col = 0
    return
  }
  const seq = s.pending + key
  const m = /^(\d*)(.*)$/.exec(seq)!
  const countText = m[1]
  const cmd = m[2]
  const count = countText ? Number(countText) : 1
  const done = (logged = true) => {
    if (logged) s.log.push(seq)
    s.pending = ''
  }
  const needsMore = ['d', 'g', 'y', 'r', 'c', 'Z']
  if (needsMore.includes(cmd)) {
    s.pending = seq
    return
  }
  switch (cmd) {
    case 'h':
    case 'ArrowLeft':
      s.col = Math.max(0, s.col - count)
      return done(false)
    case 'l':
    case 'ArrowRight':
      s.col = Math.min(Math.max(0, lineLen(s) - 1), s.col + count)
      return done(false)
    case 'j':
    case 'ArrowDown':
      s.row = Math.min(s.lines.length - 1, s.row + count)
      clampNormal(s)
      return done(false)
    case 'k':
    case 'ArrowUp':
      s.row = Math.max(0, s.row - count)
      clampNormal(s)
      return done(false)
    case 'w':
      for (let i = 0; i < count; i++) [s.row, s.col] = nextWord(s, s.row, s.col)
      return done(false)
    case 'b':
      for (let i = 0; i < count; i++) [s.row, s.col] = prevWord(s, s.row, s.col)
      return done(false)
    case 'e':
      for (let i = 0; i < count; i++) [s.row, s.col] = endWord(s, s.row, s.col)
      return done(false)
    case '$':
      s.col = Math.max(0, lineLen(s) - 1)
      return done(false)
    case '^':
      s.col = Math.max(0, s.lines[s.row].search(/\S/))
      return done(false)
    case 'gg':
      s.row = countText ? Math.min(count, s.lines.length) - 1 : 0
      s.col = 0
      return done()
    case 'G':
      s.row = countText ? Math.min(count, s.lines.length) - 1 : s.lines.length - 1
      s.col = 0
      return done()
    case 'x': {
      if (!lineLen(s)) return done()
      remember(s)
      const line = s.lines[s.row]
      s.register = { text: [line.slice(s.col, s.col + count)], linewise: false }
      s.lines[s.row] = line.slice(0, s.col) + line.slice(s.col + count)
      clampNormal(s)
      return done()
    }
    case 'dd':
      remember(s)
      deleteLines(s, count)
      return done()
    case 'dw': {
      remember(s)
      const line = s.lines[s.row]
      let end = s.col
      for (let i = 0; i < count; i++) {
        const [r, c] = nextWord(s, s.row, end)
        end = r === s.row ? c : line.length
        if (r !== s.row) break
      }
      if (end === s.col) end = line.length
      s.register = { text: [line.slice(s.col, end)], linewise: false }
      s.lines[s.row] = line.slice(0, s.col) + line.slice(end)
      clampNormal(s)
      return done()
    }
    case 'D':
    case 'd$': {
      remember(s)
      const line = s.lines[s.row]
      s.register = { text: [line.slice(s.col)], linewise: false }
      s.lines[s.row] = line.slice(0, s.col)
      clampNormal(s)
      return done()
    }
    case 'cw':
    case 'ce':
    case 'C':
    case 'cc': {
      remember(s)
      const line = s.lines[s.row]
      if (cmd === 'cc') s.lines[s.row] = ''
      else if (cmd === 'C') s.lines[s.row] = line.slice(0, s.col)
      else {
        const [, e] = endWord(s, s.row, Math.max(0, s.col - 1))
        const end = cls(line[s.col]) === 0 ? s.col + 1 : Math.min(line.length, e + 1)
        s.lines[s.row] = line.slice(0, s.col) + line.slice(end)
      }
      if (cmd === 'cc') s.col = 0
      s.mode = 'insert'
      setMsg(s, '')
      return done()
    }
    case 'yy':
    case 'Y':
      s.register = { text: s.lines.slice(s.row, s.row + count), linewise: true }
      if (count >= 3) setMsg(s, `${count} lines yanked`)
      return done()
    case 'p':
    case 'P': {
      if (!s.register) return done()
      remember(s)
      if (s.register.linewise) {
        const at = cmd === 'p' ? s.row + 1 : s.row
        s.lines.splice(at, 0, ...Array.from({ length: count }, () => s.register!.text).flat())
        s.row = at
        s.col = Math.max(0, s.lines[at].search(/\S/))
      } else {
        const line = s.lines[s.row]
        const at = cmd === 'p' && line.length ? s.col + 1 : s.col
        const text = s.register.text[0].repeat(count)
        s.lines[s.row] = line.slice(0, at) + text + line.slice(at)
        s.col = at + text.length - 1
      }
      return done()
    }
    case 'u': {
      const prev = s.undo.pop()
      if (!prev) {
        setMsg(s, 'Already at oldest change')
        return done()
      }
      s.redo.push(snap(s))
      ;({ lines: s.lines, row: s.row, col: s.col } = prev)
      clampNormal(s)
      setMsg(s, '1 change; before #1')
      return done()
    }
    case 'C-r': {
      const next = s.redo.pop()
      if (!next) {
        setMsg(s, 'Already at newest change')
        return done()
      }
      s.undo.push(snap(s))
      ;({ lines: s.lines, row: s.row, col: s.col } = next)
      clampNormal(s)
      return done()
    }
    case 'J': {
      if (s.row >= s.lines.length - 1) return done()
      remember(s)
      const a = s.lines[s.row].replace(/\s+$/, '')
      const b = s.lines[s.row + 1].replace(/^\s+/, '')
      s.lines.splice(s.row, 2, b ? `${a} ${b}` : a)
      s.col = a.length
      return done()
    }
    case 'i':
    case 'a':
    case 'I':
    case 'A':
    case 'o':
    case 'O':
      remember(s)
      if (cmd === 'a' && lineLen(s)) s.col++
      if (cmd === 'I') s.col = Math.max(0, s.lines[s.row].search(/\S/))
      if (cmd === 'A') s.col = lineLen(s)
      if (cmd === 'o') {
        s.lines.splice(s.row + 1, 0, '')
        s.row++
        s.col = 0
      }
      if (cmd === 'O') {
        s.lines.splice(s.row, 0, '')
        s.col = 0
      }
      s.mode = 'insert'
      setMsg(s, '')
      return done()
    case 'n':
    case 'N':
      if (s.lastSearch) search(s, s.lastSearch, cmd === 'n')
      return done(false)
    case ':':
    case '/':
      s.mode = cmd === ':' ? 'command' : 'search'
      s.cmdline = ''
      setMsg(s, '')
      return done(false)
    case 'ZZ':
      s.pending = ''
      runCommand(s, 'x')
      return
    case 'ZQ':
      s.pending = ''
      runCommand(s, 'q!')
      return
    case 'Escape':
      return done(false)
  }
  if (cmd.length === 2 && cmd[0] === 'r') {
    if (!lineLen(s)) return done()
    remember(s)
    const line = s.lines[s.row]
    s.lines[s.row] = line.slice(0, s.col) + cmd[1] + line.slice(s.col + 1)
    return done()
  }
  // Combinación desconocida: se descarta como hace vim.
  s.pending = ''
}

function insertKey(s: VimState, key: string) {
  const line = s.lines[s.row]
  switch (key) {
    case 'Escape':
      s.mode = 'normal'
      s.col = Math.max(0, s.col - 1)
      clampNormal(s)
      return
    case 'Enter':
      s.lines.splice(s.row, 1, line.slice(0, s.col), line.slice(s.col))
      s.row++
      s.col = 0
      return
    case 'Backspace':
      if (s.col > 0) {
        s.lines[s.row] = line.slice(0, s.col - 1) + line.slice(s.col)
        s.col--
      } else if (s.row > 0) {
        const prev = s.lines[s.row - 1]
        s.lines.splice(s.row - 1, 2, prev + line)
        s.row--
        s.col = prev.length
      }
      return
    case 'ArrowLeft':
      s.col = Math.max(0, s.col - 1)
      return
    case 'ArrowRight':
      s.col = Math.min(lineLen(s), s.col + 1)
      return
    case 'ArrowUp':
    case 'ArrowDown':
      s.row = Math.max(0, Math.min(s.lines.length - 1, s.row + (key === 'ArrowUp' ? -1 : 1)))
      s.col = Math.min(s.col, lineLen(s))
      return
    case 'Tab':
      s.lines[s.row] = line.slice(0, s.col) + '\t' + line.slice(s.col)
      s.col++
      return
  }
  if (key.length === 1) {
    s.lines[s.row] = line.slice(0, s.col) + key + line.slice(s.col)
    s.col++
  }
}

function cmdlineKey(s: VimState, key: string) {
  if (key === 'Escape') {
    s.mode = 'normal'
    s.cmdline = ''
    return
  }
  if (key === 'Backspace') {
    if (!s.cmdline) s.mode = 'normal'
    s.cmdline = s.cmdline.slice(0, -1)
    return
  }
  if (key === 'Enter') {
    const text = s.cmdline
    const wasSearch = s.mode === 'search'
    s.mode = 'normal'
    s.cmdline = ''
    if (wasSearch) {
      const pattern = text || s.lastSearch || ''
      s.lastSearch = pattern
      s.log.push(`/${pattern}`)
      search(s, pattern, true)
    } else runCommand(s, text)
    return
  }
  if (key.length === 1) s.cmdline += key
}

/** Aplica una tecla y devuelve el estado nuevo (no modifica el anterior). */
export function vimKey(state: VimState, key: string): VimState {
  if (state.quit) return state
  const s = clone(state)
  if (s.mode === 'normal') normalKey(s, key)
  else if (s.mode === 'insert') insertKey(s, key)
  else cmdlineKey(s, key)
  return s
}

/** Indicador de la última línea, como lo muestra vim. */
export function statusLine(s: VimState): { left: string; error: boolean } {
  if (s.mode === 'command') return { left: `:${s.cmdline}`, error: false }
  if (s.mode === 'search') return { left: `/${s.cmdline}`, error: false }
  if (s.mode === 'insert') return { left: '-- INSERT --', error: false }
  return { left: s.message, error: s.messageIsError }
}

// ---------------------------------------------------------------------------------------
// Verificaciones de ejercicios
// ---------------------------------------------------------------------------------------

export type VimCheck =
  | { contenido_incluye: string }
  | { contenido_no_incluye: string }
  | { contenido_igual: string }
  | { linea: number; texto: string }
  | { linea_cursor: number }
  | { modo: 'normal' | 'insert' }
  | { guardado: boolean }
  | { cerrado: boolean }
  | { numeros: boolean }
  | { comando_usado: string }

export function verifyVim(s: VimState, check: VimCheck): { ok: boolean; label: string } {
  const text = s.lines.join('\n')
  if ('contenido_incluye' in check) return { ok: text.includes(check.contenido_incluye), label: `el archivo contiene "${check.contenido_incluye}"` }
  if ('contenido_no_incluye' in check) return { ok: !text.includes(check.contenido_no_incluye), label: `el archivo ya no contiene "${check.contenido_no_incluye}"` }
  if ('contenido_igual' in check) return { ok: text === check.contenido_igual.replace(/\n$/, ''), label: 'el archivo quedó exactamente como se pide' }
  if ('linea' in check) return { ok: s.lines[check.linea - 1] === check.texto, label: `la línea ${check.linea} es "${check.texto}"` }
  if ('linea_cursor' in check) return { ok: s.row === check.linea_cursor - 1, label: `el cursor está en la línea ${check.linea_cursor}` }
  if ('modo' in check) return { ok: s.mode === check.modo, label: check.modo === 'insert' ? 'estás en modo inserción' : 'estás en modo normal' }
  if ('guardado' in check) {
    const ok = s.writes > 0 && !isModified(s)
    return { ok: ok === check.guardado, label: check.guardado ? 'los cambios están guardados' : 'hay cambios sin guardar' }
  }
  if ('cerrado' in check) return { ok: s.quit === check.cerrado, label: check.cerrado ? 'saliste de vim' : 'vim sigue abierto' }
  if ('numeros' in check) return { ok: s.numbers === check.numeros, label: check.numeros ? 'se ven los números de línea' : 'sin números de línea' }
  let re: RegExp | null = null
  try {
    re = new RegExp(check.comando_usado)
  } catch {
    re = null
  }
  return { ok: !!re && s.log.some((l) => re.test(l)), label: 'usaste el comando pedido' }
}
