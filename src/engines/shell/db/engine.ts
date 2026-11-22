/**
 * Servidores de bases de datos simulados: MariaDB y PostgreSQL.
 *
 * Los datos viven en SQLite (sql.js), una base de SQLite por cada base del servidor. Encima va
 * la "personalidad" de cada motor: la sintaxis propia (AUTO_INCREMENT, SERIAL, SHOW, \d...),
 * los usuarios y sus permisos, la autenticación, el binlog de MariaDB y los mensajes de error
 * con sus códigos reales. Lo que no se puede simular bien se dice con un aviso del simulador.
 */
import type { System } from '../system'
import { sqlReady, type SqlDatabase } from './sqlite'

export type DbKind = 'mariadb' | 'postgres'

export interface DbUser {
  name: string
  /** MariaDB: 'localhost', '%', '192.168.1.%'... En PostgreSQL no se usa. */
  host: string
  password?: string
  /** unix_socket (root de MariaDB), password, o en PostgreSQL siempre password/peer según pg_hba. */
  plugin: 'unix_socket' | 'password'
  superuser: boolean
  login: boolean
  createdb: boolean
}

export interface Grant {
  user: string
  db: string
  table: string
  privs: Set<string>
  grantOption: boolean
}

export interface DbInstance {
  name: string
  owner: string
  db?: SqlDatabase
  /** SQL que todavía no se pudo cargar porque sql.js no estaba listo. */
  pending: string[]
  /** CREATE TABLE tal como lo escribieron (para los volcados). */
  ddl: Map<string, string>
  tableOwner: Map<string, string>
  /** PostgreSQL: quién puede crear objetos en el esquema public además del dueño de la base. */
  schemaCreate: Set<string>
  /** PostgreSQL: permisos por defecto para tablas futuras (ALTER DEFAULT PRIVILEGES). */
  defaultPrivs: { user: string; privs: Set<string> }[]
  /** Índices creados (para EXPLAIN y SHOW INDEX). */
  indexes: Map<string, { table: string; columns: string[]; unique: boolean }>
}

export interface BinlogEvent {
  pos: number
  end: number
  time: number
  db: string
  sql: string
  thread: number
}

export interface BinlogFile {
  name: string
  events: BinlogEvent[]
  size: number
}

export interface HbaRule {
  type: 'local' | 'host' | 'hostssl' | 'hostnossl'
  db: string
  user: string
  address?: string
  method: string
  line: number
}

export interface DbConfig {
  bind: string
  port: number
  logBin?: string
  serverId: number
  maxConnections: number
  slowLog: boolean
  longQueryTime: number
  /** PostgreSQL */
  listen: string
  hba: HbaRule[]
  /** Todas las opciones del archivo de configuración (para SHOW VARIABLES). */
  raw?: Map<string, string>
}

export interface DbServer {
  kind: DbKind
  sys: System
  dbs: Map<string, DbInstance>
  users: DbUser[]
  grants: Grant[]
  binlog: BinlogFile[]
  /** Configuración leída al arrancar (la que vale hasta reiniciar). */
  loaded?: DbConfig
  /** PostgreSQL en Rocky: el cluster se crea con postgresql-setup --initdb. */
  initialized: boolean
  thread: number
}

export type Result =
  | { kind: 'rows'; columns: string[]; rows: unknown[][]; vertical?: boolean }
  | { kind: 'ok'; affected: number; tag?: string; info?: string; warnings?: number }
  | { kind: 'msg'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'empty' }

export interface Session {
  server: DbServer
  user: DbUser
  db?: string
  /** IP o 'localhost' desde donde se conectó. */
  from: string
  /** Hora de los eventos (mysqlbinlog con SET TIMESTAMP la cambia). */
  timestamp?: number
  /** No registrar en el binlog (SET sql_log_bin = 0). */
  noLog?: boolean
}

const SERVERS = new WeakMap<System, Map<DbKind, DbServer>>()

export function versionOf(sys: System, kind: DbKind): string {
  if (kind === 'mariadb') return sys.distro === 'rocky' ? '10.11.11-MariaDB' : '11.8.6-MariaDB-5ubuntu0.1'
  return sys.distro === 'rocky' ? '16.10' : '18.3 (Ubuntu 18.3-1)'
}

export function pgMajor(sys: System): string {
  return sys.distro === 'rocky' ? '16' : '18'
}

export function dbServer(sys: System, kind: DbKind): DbServer {
  let m = SERVERS.get(sys)
  if (!m) {
    m = new Map()
    SERVERS.set(sys, m)
  }
  let s = m.get(kind)
  if (!s) {
    s = { kind, sys, dbs: new Map(), users: [], grants: [], binlog: [], initialized: kind === 'mariadb' || sys.distro === 'ubuntu', thread: 30 }
    if (kind === 'mariadb') {
      s.users.push({ name: 'root', host: 'localhost', plugin: 'unix_socket', superuser: true, login: true, createdb: true })
      s.users.push({ name: 'mysql', host: 'localhost', plugin: 'unix_socket', superuser: true, login: true, createdb: true })
    } else {
      s.users.push({ name: 'postgres', host: '', plugin: 'password', superuser: true, login: true, createdb: true })
      newDb(s, 'postgres', 'postgres')
    }
    m.set(kind, s)
  }
  return s
}

export function hasServer(sys: System, kind: DbKind): DbServer | undefined {
  return SERVERS.get(sys)?.get(kind)
}

export function newDb(s: DbServer, name: string, owner: string): DbInstance {
  const inst: DbInstance = { name, owner, pending: [], ddl: new Map(), tableOwner: new Map(), schemaCreate: new Set(), defaultPrivs: [], indexes: new Map() }
  s.dbs.set(name, inst)
  return inst
}

/** La base con sus datos ya cargados en SQLite (si sql.js está listo). */
export function materialize(s: DbServer, inst: DbInstance): SqlDatabase | undefined {
  if (inst.db) return inst.db
  const SQL = sqlReady()
  if (!SQL) return undefined
  inst.db = new SQL.Database()
  const pending = inst.pending
  inst.pending = []
  const owner = s.users.find((u) => u.name === inst.owner) ?? s.users[0]
  const sess: Session = { server: s, user: owner, db: inst.name, from: 'localhost', noLog: true }
  for (const stmt of pending.flatMap((p) => splitSql(p, s.kind))) execute(sess, stmt)
  return inst.db
}

// ---------------------------------------------------------------------------------------
// Separar sentencias
// ---------------------------------------------------------------------------------------

/** Divide un texto en sentencias, respetando comillas y comentarios. */
export function splitSql(text: string, kind: DbKind): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const src = text.replace(/\/\*!\*\/;/g, ';').replace(/^DELIMITER .*$/gim, '')
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\' && kind === 'mariadb') {
          j += 2
          continue
        }
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      cur += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if ((c === '-' && next === '-' && (kind === 'postgres' || /\s/.test(src[i + 2] ?? ' '))) || (c === '#' && kind === 'mariadb')) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      // /*!40101 ... */ es código que MySQL y MariaDB sí ejecutan: se conserva el contenido.
      if (kind === 'mariadb' && src[i + 2] === '!') cur += ' ' + src.slice(i + 3, end < 0 ? src.length : end).replace(/^\d{5,6}/, '') + ' '
      else cur += ' '
      i = stop
      continue
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** ¿Quedó una sentencia sin terminar (falta ";" o una comilla)? */
export function unterminated(text: string, kind: DbKind): boolean {
  let inQ = ''
  let last = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '\\' && kind === 'mariadb') {
        i++
        continue
      }
      if (c === inQ) inQ = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inQ = c
      continue
    }
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (!/\s/.test(c)) last = c
  }
  if (inQ) return true
  return text.trim() !== '' && last !== ';' && !/\\G\s*$/.test(text)
}

// ---------------------------------------------------------------------------------------
// Identificadores y nombres
// ---------------------------------------------------------------------------------------

export function unquote(s: string): string {
  const t = s.trim()
  if (/^(['"`]).*\1$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/** 'app'@'localhost' → { name, host } */
export function parseAccount(s: string): { name: string; host: string } {
  const m = /^\s*(['"`]?)([^'"`@]*)\1\s*(?:@\s*(['"`]?)([^'"`]*)\3)?\s*$/.exec(s)
  if (!m) return { name: unquote(s), host: '%' }
  return { name: m[2], host: m[4] ?? '%' }
}

export function accountKey(u: { name: string; host: string }, kind: DbKind): string {
  return kind === 'mariadb' ? `'${u.name}'@'${u.host}'` : u.name
}

export function findUser(s: DbServer, name: string, host?: string): DbUser | undefined {
  if (s.kind === 'postgres') return s.users.find((u) => u.name === name)
  return s.users.find((u) => u.name === name && (host === undefined || u.host === host))
}

/** Usuario de MariaDB que corresponde a una conexión desde "from" (el más específico gana). */
export function matchUser(s: DbServer, name: string, from: string): DbUser | undefined {
  const cands = s.users.filter((u) => u.name === name && hostMatch(u.host, from))
  return cands.sort((a, b) => specificity(b.host) - specificity(a.host))[0]
}

function specificity(h: string): number {
  if (h === '%') return 0
  return h.replace(/[%_]/g, '').length + (h.includes('%') ? 0 : 100)
}

export function hostMatch(pattern: string, from: string): boolean {
  const f = from === '127.0.0.1' || from === '::1' ? 'localhost' : from
  if (pattern === 'localhost') return f === 'localhost'
  if (pattern === '%') return true
  if (pattern === from) return true
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$')
  return re.test(from) || (f === 'localhost' && re.test('127.0.0.1'))
}

// ---------------------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------------------

const ALL_PG_TABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

export function hasPriv(sess: Session, priv: string, db: string, table = '*'): boolean {
  const s = sess.server
  const u = sess.user
  if (u.superuser) return true
  if (s.kind === 'postgres') {
    const inst = s.dbs.get(db)
    if (!inst) return false
    if (priv === 'CREATE') return inst.owner === u.name || inst.schemaCreate.has(u.name)
    if (table !== '*' && inst.tableOwner.get(table) === u.name) return true
    return s.grants.some((g) => g.user === u.name && g.db === db && (g.table === table || g.table === '*') && (g.privs.has(priv) || g.privs.has('ALL')))
  }
  const key = accountKey(u, 'mariadb')
  return s.grants.some((g) => g.user === key && (g.db === '*' || g.db === db) && (g.table === '*' || g.table === table) && (g.privs.has(priv) || g.privs.has('ALL')))
}

/** ¿Tiene algún permiso sobre la base? (para USE y SHOW DATABASES de MariaDB) */
export function anyPrivOn(sess: Session, db: string): boolean {
  if (sess.user.superuser) return true
  const key = accountKey(sess.user, sess.server.kind)
  return sess.server.grants.some((g) => g.user === (sess.server.kind === 'mariadb' ? key : sess.user.name) && (g.db === '*' || g.db === db) && g.privs.size > 0)
}

// ---------------------------------------------------------------------------------------
// Errores con el formato de cada motor
// ---------------------------------------------------------------------------------------

export function myErr(code: number, state: string, msg: string): Result {
  return { kind: 'error', text: `ERROR ${code} (${state}): ${msg}` }
}

export function pgErr(msg: string, extra = ''): Result {
  return { kind: 'error', text: `ERROR:  ${msg}${extra ? '\n' + extra : ''}` }
}

function near(stmt: string, word: string): string {
  const i = stmt.indexOf(word)
  return (i >= 0 ? stmt.slice(i) : stmt).slice(0, 80)
}

/** Traduce un error de SQLite al mensaje del motor simulado. */
function translateError(sess: Session, stmt: string, e: unknown): Result {
  const m = String((e as Error)?.message ?? e)
  const s = sess.server
  const db = sess.db ?? ''
  let r: RegExpExecArray | null
  if ((r = /no such table: (?:\w+\.)?(\w+)/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1146, '42S02', `Table '${db}.${r[1]}' doesn't exist`) : pgErr(`relation "${r[1]}" does not exist`)
  }
  if ((r = /table (\w+) already exists/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1050, '42S01', `Table '${r[1]}' already exists`) : pgErr(`relation "${r[1]}" already exists`)
  }
  if ((r = /no such column: (?:\w+\.)?(\w+)/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1054, '42S22', `Unknown column '${r[1]}' in 'SELECT'`) : pgErr(`column "${r[1]}" does not exist`)
  }
  if ((r = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1062, '23000', `Duplicate entry for key '${r[2] === 'id' ? 'PRIMARY' : r[2]}'`) : pgErr(`duplicate key value violates unique constraint "${r[1]}_${r[2] === 'id' ? 'pkey' : r[2] + '_key'}"`)
  }
  if ((r = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1048, '23000', `Column '${r[2]}' cannot be null`) : pgErr(`null value in column "${r[2]}" of relation "${r[1]}" violates not-null constraint`)
  }
  if (/FOREIGN KEY constraint failed/.test(m)) {
    return s.kind === 'mariadb' ? myErr(1452, '23000', 'Cannot add or update a child row: a foreign key constraint fails') : pgErr('insert or update on table violates foreign key constraint')
  }
  if ((r = /near "([^"]*)": syntax error/.exec(m)) || /syntax error|incomplete input/.test(m)) {
    const w = r?.[1] ?? ''
    return s.kind === 'mariadb'
      ? myErr(1064, '42000', `You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '${near(stmt, w)}' at line 1`)
      : pgErr(w ? `syntax error at or near "${w}"` : 'syntax error at end of input')
  }
  if ((r = /no such function: (\w+)/.exec(m))) {
    return s.kind === 'mariadb' ? myErr(1305, '42000', `FUNCTION ${db}.${r[1]} does not exist`) : pgErr(`function ${r[1].toLowerCase()}() does not exist`)
  }
  return s.kind === 'mariadb' ? myErr(1105, 'HY000', m) : pgErr(m)
}

// ---------------------------------------------------------------------------------------
// Traducción de sintaxis a SQLite
// ---------------------------------------------------------------------------------------

/** Literales de MariaDB con barra invertida ('O\\'Brien', 'línea\\n') al estilo estándar. */
function normalizeLiterals(stmt: string): string {
  return stmt.replace(/'((?:[^'\\]|\\.|'')*)'/g, (_, body: string) => {
    const t = body.replace(/\\(.)/g, (__, ch: string) => ({ n: '\n', t: '\t', r: '\r', '0': '', Z: '\x1a' } as Record<string, string>)[ch] ?? (ch === "'" ? "''" : ch))
    return `'${t}'`
  })
}

function toSqlite(kind: DbKind, stmt: string, sess: Session): string {
  let s = kind === 'mariadb' ? normalizeLiterals(stmt) : stmt
  // Tipos con autoincremento → la columna INTEGER clave de SQLite.
  s = s.replace(/\b(?:BIG|SMALL|MEDIUM|TINY)?INT(?:EGER)?(?:\s*\(\s*\d+\s*\))?(\s+UNSIGNED)?(\s+NOT\s+NULL)?\s+AUTO_INCREMENT\b/gi, 'INTEGER$2')
  s = s.replace(/\b(?:BIG|SMALL)?SERIAL\b/gi, 'INTEGER')
  s = s.replace(/\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/gi, '')
  s = s.replace(/\bINT(?:EGER)?\s*\(\s*\d+\s*\)/gi, 'INTEGER')
  s = s.replace(/\bUNSIGNED\b/gi, '')
  s = s.replace(/\)\s*(ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE|AUTO_INCREMENT)\b[^;]*$/i, ')')
  s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\))?/gi, '')
  s = s.replace(/\b(?:CHARACTER\s+SET|COLLATE)\s+\w+/gi, '')
  s = s.replace(/\bCOMMENT\s+'[^']*'/gi, '')
  // Índices dentro del CREATE TABLE de MariaDB (KEY idx (col)): se crean aparte.
  s = s.replace(/,\s*(?:UNIQUE\s+)?(?:KEY|INDEX)\s+`?\w+`?\s*\([^)]*\)/gi, '')
  s = s.replace(/\bNOW\s*\(\s*\)|\bCURRENT_TIMESTAMP\s*\(\s*\)|\bLOCALTIMESTAMP\b/gi, "datetime('now','localtime')")
  s = s.replace(/\bCURDATE\s*\(\s*\)|\bCURRENT_DATE\s*\(\s*\)/gi, "date('now','localtime')")
  s = s.replace(/\bTRUE\b/g, '1').replace(/\bFALSE\b/g, '0')
  s = s.replace(/\bILIKE\b/gi, 'LIKE')
  s = s.replace(/::\s*[a-z_]+(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?/gi, '')
  s = s.replace(/\bpublic\./gi, '')
  s = s.replace(/\bVERSION\s*\(\s*\)/gi, `'${kind === 'mariadb' ? versionOf(sess.server.sys, kind) : `PostgreSQL ${versionOf(sess.server.sys, kind)} on x86_64-pc-linux-gnu`}'`)
  s = s.replace(/\bCURRENT_USER\s*\(\s*\)/gi, `'${sess.user.name}@${kind === 'mariadb' ? sess.user.host : ''}'`.replace(/@'$/, "'"))
  s = s.replace(/\b(?:USER|SESSION_USER)\s*\(\s*\)/gi, `'${sess.user.name}@${sess.from === 'localhost' ? 'localhost' : sess.from}'`)
  s = s.replace(/\bcurrent_user\b(?!\s*\()/gi, `'${sess.user.name}'`)
  s = s.replace(/\bDATABASE\s*\(\s*\)|\bcurrent_database\s*\(\s*\)/gi, sess.db ? `'${sess.db}'` : 'NULL')
  s = s.replace(/\bCONCAT\s*\(([^()]*)\)/gi, (_, a: string) => `(${a.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).join(' || ')})`)
  s = s.replace(/\bIFNULL\s*\(/gi, 'ifnull(').replace(/\bRAND\s*\(\s*\)/gi, 'random()')
  if (kind === 'mariadb') s = s.replace(/\bLIMIT\s+(\d+)\s*,\s*(\d+)/gi, 'LIMIT $2 OFFSET $1')
  return s
}

// ---------------------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------------------

function words(stmt: string): string[] {
  return stmt.trim().split(/\s+/)
}

function tablesIn(stmt: string): string[] {
  const out = new Set<string>()
  for (const m of stmt.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+(?:ONLY\s+)?([`"]?[\w.]+[`"]?)/gi)) {
    const n = unquote(m[1]).split('.').pop()!
    if (!/^(SELECT|IF|ONLY|stdin|LATERAL)$/i.test(n)) out.add(n)
  }
  return [...out]
}

function requiredPriv(stmt: string): string | undefined {
  const w = words(stmt).slice(0, 3).join(' ').toUpperCase()
  if (/^(SELECT|WITH|EXPLAIN|DESC|DESCRIBE)\b/.test(w)) return 'SELECT'
  if (/^(INSERT|REPLACE)\b/.test(w)) return 'INSERT'
  if (/^UPDATE\b/.test(w)) return 'UPDATE'
  if (/^DELETE\b/.test(w)) return 'DELETE'
  if (/^TRUNCATE\b/.test(w)) return 'DROP'
  if (/^CREATE (TABLE|TEMPORARY|VIEW)/.test(w)) return 'CREATE'
  if (/^CREATE (UNIQUE )?INDEX/.test(w)) return 'INDEX'
  if (/^DROP (TABLE|VIEW)/.test(w)) return 'DROP'
  if (/^DROP INDEX/.test(w)) return 'INDEX'
  if (/^ALTER TABLE/.test(w)) return 'ALTER'
  return undefined
}

/** Registra en el binlog lo que cambia datos o estructura (MariaDB con log_bin). */
function logEvent(sess: Session, stmt: string) {
  const s = sess.server
  if (s.kind !== 'mariadb' || sess.noLog || !s.loaded?.logBin) return
  if (!/^\s*(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|RENAME)\b/i.test(stmt)) return
  let file = s.binlog.at(-1)
  if (!file) {
    file = { name: `${s.loaded.logBin.split('/').pop()}.000001`, events: [], size: 256 }
    s.binlog.push(file)
  }
  const len = 120 + stmt.length
  const pos = file.size
  file.events.push({ pos, end: pos + len, time: sess.timestamp ?? Date.now(), db: sess.db ?? '', sql: stmt.trim(), thread: s.thread })
  file.size = pos + len
  writeBinlogFiles(s)
}

export function writeBinlogFiles(s: DbServer) {
  if (!s.loaded?.logBin) return
  const dir = s.loaded.logBin.slice(0, s.loaded.logBin.lastIndexOf('/')) || '/var/lib/mysql'
  const base = s.loaded.logBin.split('/').pop()!
  const vfs = s.sys.vfs
  const cred = { uid: 0, gid: 0, groups: [0] } as never
  try {
    if (!vfs.exists(dir)) return
    const mysqlUid = s.sys.users.get('mysql')
    for (const f of s.binlog) {
      const path = `${dir}/${f.name}`
      vfs.writeFile(path, `\u00febin\u0001SIMBINLOG:${f.name}:${f.events.length}\n`, cred, { mode: 0o660 })
      if (mysqlUid) {
        const n = vfs.stat(path, cred)
        n.uid = mysqlUid.uid
        n.gid = mysqlUid.gid
        n.size = f.size
      }
    }
    vfs.writeFile(`${dir}/${base}.index`, s.binlog.map((f) => `./${f.name}`).join('\n') + '\n', cred, { mode: 0o660 })
  } catch {
    // Sin permisos o sin carpeta: el binlog sigue en memoria.
  }
}

export function rotateBinlog(s: DbServer) {
  if (!s.loaded?.logBin) return
  const last = s.binlog.at(-1)
  const n = last ? Number(last.name.split('.').pop()) + 1 : 1
  s.binlog.push({ name: `${s.loaded.logBin.split('/').pop()}.${String(n).padStart(6, '0')}`, events: [], size: 256 })
  writeBinlogFiles(s)
}

/** Carpeta donde están los archivos del binlog. */
export function binlogDir(s: DbServer): string {
  const lb = s.loaded?.logBin ?? '/var/lib/mysql/mariadb-bin'
  return lb.slice(0, lb.lastIndexOf('/')) || '/var/lib/mysql'
}

/** Ejecuta una sentencia SQL en la sesión. */
export function execute(sess: Session, raw: string): Result {
  const stmt = raw.trim().replace(/;\s*$/, '')
  if (!stmt) return { kind: 'empty' }
  const s = sess.server
  // Las sentencias especiales (GRANT ... ON ALL TABLES, SHOW TABLES, ALTER ... OWNER) necesitan
  // las tablas de la base ya creadas.
  const cur = sess.db ? s.dbs.get(sess.db) : undefined
  if (cur) materialize(s, cur)
  const special = s.kind === 'mariadb' ? mariadbSpecial(sess, stmt) : pgSpecial(sess, stmt)
  if (special) {
    if (special.kind !== 'error' && special.kind !== 'rows') logEvent(sess, stmt)
    return special
  }
  if (!sess.db) return s.kind === 'mariadb' ? myErr(1046, '3D000', 'No database selected') : pgErr('no database selected')
  const inst = s.dbs.get(sess.db)
  if (!inst) return s.kind === 'mariadb' ? myErr(1049, '42000', `Unknown database '${sess.db}'`) : pgErr(`database "${sess.db}" does not exist`)
  const db = materialize(s, inst)
  if (!db) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando. Probá de nuevo en un segundo.' }

  // Permisos.
  const priv = requiredPriv(stmt)
  if (priv) {
    const tables = tablesIn(stmt).filter((t) => !/^(sqlite_|information_schema)/i.test(t))
    if (priv === 'CREATE' && !hasPriv(sess, 'CREATE', sess.db)) {
      const t = tablesIn(stmt)[0] ?? ''
      return s.kind === 'mariadb' ? myErr(1142, '42000', `CREATE command denied to user '${sess.user.name}'@'${sess.from}' for table \`${sess.db}\`.\`${t}\``) : pgErr('permission denied for schema public', `LINE 1: ${stmt.slice(0, 60)}`)
    }
    for (const t of priv === 'CREATE' ? [] : tables) {
      const first = /^\s*(INSERT|REPLACE|UPDATE|DELETE)/i.test(stmt) ? tables[0] : undefined
      const need = t === first || priv !== 'SELECT' ? priv : 'SELECT'
      if (!hasPriv(sess, need, sess.db, t) && (s.kind === 'postgres' ? true : !hasPriv(sess, need, sess.db))) {
        return s.kind === 'mariadb'
          ? myErr(1142, '42000', `${need} command denied to user '${sess.user.name}'@'${sess.from}' for table \`${sess.db}\`.\`${t}\``)
          : pgErr(`permission denied for table ${t}`)
      }
    }
  }

  // Catálogos de PostgreSQL que consultan los módulos de Ansible y los scripts: se arman al vuelo.
  if (s.kind === 'postgres' && /\b(pg_catalog\.)?(pg_database|pg_roles|pg_user)\b/i.test(stmt)) syncPgCatalog(s, db)
  let sql = toSqlite(s.kind, stmt, sess).replace(/\bpg_catalog\.(pg_\w+)/gi, '$1')
  // ALTER TABLE t ADD INDEX idx (col) → CREATE INDEX
  const addIdx = /^ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+(UNIQUE\s+)?(?:INDEX|KEY)\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)\s*$/i.exec(stmt)
  if (addIdx) sql = `CREATE ${addIdx[2] ? 'UNIQUE ' : ''}INDEX ${addIdx[3]} ON ${addIdx[1]} (${addIdx[4]})`
  if (/^TRUNCATE\s+(TABLE\s+)?/i.test(stmt)) sql = `DELETE FROM ${unquote(stmt.replace(/^TRUNCATE\s+(TABLE\s+)?/i, '').split(/\s/)[0])}`
  const inlineIdx = /^CREATE\s+TABLE/i.test(stmt) ? [...stmt.matchAll(/,\s*(UNIQUE\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/gi)] : []

  let res: Result
  try {
    if (/^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i.test(sql) && !/^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      const r = db.exec(sql)
      const first = r[0]
      let columns = first?.columns ?? columnsOf(sql)
      const rows = decimalScale(inst, stmt, columns, first?.values ?? [])
      if (s.kind === 'postgres') columns = columns.map((c) => (/^(\w+)\s*\(.*\)$/.exec(c)?.[1]?.toLowerCase() ?? (/^[\w.]+$/.test(c) ? c.split('.').pop()! : '?column?')))
      res = { kind: 'rows', columns, rows }
    } else {
      db.run(sql)
      const n = /^\s*(CREATE|DROP|ALTER)\b/i.test(sql) ? 0 : db.getRowsModified()
      res = { kind: 'ok', affected: n, tag: pgTag(stmt, n) }
    }
  } catch (e) {
    return translateError(sess, stmt, e)
  }

  // Metadatos de lo que se creó o borró.
  const ct = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?[\w.]+[`"]?)/i.exec(stmt)
  if (ct) {
    const t = unquote(ct[1]).split('.').pop()!
    if (!inst.ddl.has(t)) {
      inst.ddl.set(t, stmt)
      inst.tableOwner.set(t, sess.user.name)
      for (const d of inst.defaultPrivs) s.grants.push({ user: d.user, db: inst.name, table: t, privs: new Set(d.privs), grantOption: false })
    }
    for (const m of inlineIdx) {
      try {
        db.run(`CREATE ${m[1] ? 'UNIQUE ' : ''}INDEX ${m[2]} ON ${t} (${m[3].replace(/`/g, '')})`)
        inst.indexes.set(m[2], { table: t, columns: m[3].replace(/`/g, '').split(',').map((x) => x.trim()), unique: !!m[1] })
      } catch {
        // índice repetido
      }
    }
  }
  const dt = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+)$/i.exec(stmt)
  if (dt) for (const n of dt[1].split(',').map((x) => unquote(x.trim()).split('.').pop()!)) {
    inst.ddl.delete(n)
    inst.tableOwner.delete(n)
    s.grants = s.grants.filter((g) => !(g.db === inst.name && g.table === n))
    for (const [k, v] of inst.indexes) if (v.table === n) inst.indexes.delete(k)
  }
  const ci = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)/i.exec(stmt)
  if (ci) inst.indexes.set(ci[2], { table: ci[3], columns: ci[4].split(',').map((x) => x.trim().replace(/[`"]/g, '')), unique: !!ci[1] })
  if (addIdx) inst.indexes.set(addIdx[3], { table: addIdx[1], columns: addIdx[4].split(',').map((x) => x.trim().replace(/[`"]/g, '')), unique: !!addIdx[2] })
  const at = /^ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+(?:COLUMN\s+)?([`"]?\w+[`"]?\s+[^,]+)$/i.exec(stmt)
  if (at && !addIdx && inst.ddl.has(at[1])) inst.ddl.set(at[1], inst.ddl.get(at[1])!.replace(/\)\s*([^)]*)$/, `,\n  ${at[2]}\n)$1`))
  logEvent(sess, stmt)
  return res
}

/** Las columnas DECIMAL(p,s) se muestran con s decimales (185000.00), como en MariaDB y PostgreSQL. */
function decimalScale(inst: DbInstance, stmt: string, columns: string[], rows: unknown[][]): unknown[][] {
  const scales = new Map<string, number>()
  for (const t of tablesIn(stmt)) {
    const ddl = inst.ddl.get(t)
    if (!ddl) continue
    for (const m of ddl.matchAll(/[`"]?(\w+)[`"]?\s+(?:DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/gi)) scales.set(m[1].toLowerCase(), Number(m[2]))
  }
  if (!scales.size) return rows
  const list = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(stmt)?.[1]
  const exprs = list && list.trim() !== '*' ? list.split(/,(?![^(]*\))/).map((x) => x.trim()) : []
  const scaleOf = columns.map((c, i) => {
    const direct = scales.get(c.toLowerCase())
    if (direct !== undefined) return direct
    const e = exprs[i]
    if (!e || /^\s*count\s*\(/i.test(e)) return undefined
    for (const [col, sc] of scales) if (new RegExp(`\\b${col}\\b`, 'i').test(e) && /^(sum|min|max|avg)?\s*\(?/i.test(e)) return /^\s*avg\s*\(/i.test(e) ? Math.max(sc, 4) + 2 : sc
    return undefined
  })
  if (scaleOf.every((x) => x === undefined)) return rows
  return rows.map((r) => r.map((v, i) => (typeof v === 'number' && scaleOf[i] !== undefined ? v.toFixed(scaleOf[i]) : v)))
}

function columnsOf(sql: string): string[] {
  const m = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql)
  if (!m || m[1].trim() === '*') return []
  return m[1].split(',').map((c) => c.trim().split(/\s+AS\s+|\s+/i).pop()!.replace(/[`"]/g, ''))
}

function pgTag(stmt: string, n: number): string {
  const w = words(stmt).map((x) => x.toUpperCase())
  if (w[0] === 'INSERT') return `INSERT 0 ${n}`
  if (w[0] === 'UPDATE' || w[0] === 'DELETE') return `${w[0]} ${n}`
  if (w[0] === 'TRUNCATE') return 'TRUNCATE TABLE'
  if (w[0] === 'CREATE' && w[1] === 'UNIQUE') return 'CREATE INDEX'
  if (w[0] === 'CREATE' || w[0] === 'DROP' || w[0] === 'ALTER') return `${w[0]} ${w[1] === 'TEMPORARY' ? 'TABLE' : w[1]}`
  if (w[0] === 'BEGIN' || w[0] === 'START') return 'BEGIN'
  return w[0]
}

// ---------------------------------------------------------------------------------------
// Sentencias propias de MariaDB
// ---------------------------------------------------------------------------------------

function privList(text: string, kind: DbKind): Set<string> {
  const t = text.toUpperCase().replace(/\s+PRIVILEGES\b/, '').trim()
  if (t === 'ALL') return new Set(['ALL'])
  return new Set(t.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean).map((x) => (kind === 'postgres' && x === 'ALL' ? 'ALL' : x)))
}

function mariadbSpecial(sess: Session, raw: string): Result | undefined {
  const stmt = raw.replace(/\s+/g, ' ').trim()
  const s = sess.server
  const U = stmt.toUpperCase().replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  const denied = (what: string) => myErr(1227, '42000', `Access denied; you need (at least one of) the ${what} privilege(s) for this operation`)
  const userDbs = () => [...s.dbs.keys()].filter((d) => anyPrivOn(sess, d))

  if (/^ALTER TABLE \S+ (DISABLE|ENABLE) KEYS$/.test(U)) return { kind: 'ok', affected: 0 }
  if (/^(SET|LOCK TABLES|UNLOCK TABLES|FLUSH TABLES|START TRANSACTION|BEGIN|COMMIT|ROLLBACK|ANALYZE|OPTIMIZE)\b/.test(U)) {
    const ts = /^SET\s+TIMESTAMP\s*=\s*(\d+)/i.exec(stmt)
    if (ts) sess.timestamp = Number(ts[1]) * 1000
    if (/^SET\s+(@@SESSION\.)?SQL_LOG_BIN\s*=\s*0/i.test(stmt)) sess.noLog = true
    if (/^(START TRANSACTION|BEGIN|COMMIT|ROLLBACK)/.test(U) && sess.db) {
      const db = materialize(s, s.dbs.get(sess.db)!)
      try {
        db?.run(U.startsWith('START') ? 'BEGIN' : U.split(' ')[0])
      } catch {
        // transacción ya abierta o cerrada
      }
    }
    if (/^(ANALYZE|OPTIMIZE)/.test(U)) {
      const t = unquote(words(stmt)[2] ?? '')
      return { kind: 'rows', columns: ['Table', 'Op', 'Msg_type', 'Msg_text'], rows: [[`${sess.db}.${t}`, U.startsWith('ANALYZE') ? 'analyze' : 'optimize', 'status', 'OK']] }
    }
    return { kind: 'ok', affected: 0 }
  }
  if (/^USE\b/.test(U)) {
    const d = unquote(words(stmt)[1] ?? '')
    if (!s.dbs.has(d) && !['mysql', 'information_schema', 'performance_schema', 'sys'].includes(d)) return myErr(1049, '42000', `Unknown database '${d}'`)
    if (!anyPrivOn(sess, d)) return myErr(1044, '42000', `Access denied for user '${sess.user.name}'@'${sess.user.host}' to database '${d}'`)
    sess.db = d
    return { kind: 'msg', text: 'Database changed' }
  }
  if (/^SHOW (DATABASES|SCHEMAS)/.test(U)) {
    const sys = sess.user.superuser ? ['information_schema', 'mysql', 'performance_schema', 'sys'] : ['information_schema']
    return { kind: 'rows', columns: ['Database'], rows: [...sys, ...userDbs()].sort().map((d) => [d]) }
  }
  if ((m = /^CREATE (?:DATABASE|SCHEMA) (IF NOT EXISTS )?([`"]?\w+[`"]?)/i.exec(stmt))) {
    const name = unquote(m[2])
    if (!sess.user.superuser && !s.grants.some((g) => g.user === accountKey(sess.user, 'mariadb') && g.db === '*' && (g.privs.has('CREATE') || g.privs.has('ALL')))) {
      return myErr(1044, '42000', `Access denied for user '${sess.user.name}'@'${sess.user.host}' to database '${name}'`)
    }
    if (s.dbs.has(name)) return m[1] ? { kind: 'ok', affected: 0, warnings: 1 } : myErr(1007, 'HY000', `Can't create database '${name}'; database exists`)
    newDb(s, name, sess.user.name)
    return { kind: 'ok', affected: 1 }
  }
  if ((m = /^DROP (?:DATABASE|SCHEMA) (IF EXISTS )?([`"]?\w+[`"]?)/i.exec(stmt))) {
    const name = unquote(m[2])
    const inst = s.dbs.get(name)
    if (!inst) return m[1] ? { kind: 'ok', affected: 0, warnings: 1 } : myErr(1008, 'HY000', `Can't drop database '${name}'; database doesn't exist`)
    if (!hasPriv(sess, 'DROP', name)) return myErr(1044, '42000', `Access denied for user '${sess.user.name}'@'${sess.user.host}' to database '${name}'`)
    const n = inst.ddl.size
    inst.db?.close()
    s.dbs.delete(name)
    s.grants = s.grants.filter((g) => g.db !== name || g.table === '*')
    if (sess.db === name) sess.db = undefined
    return { kind: 'ok', affected: n }
  }
  if (/^SHOW (FULL )?TABLES/.test(U)) {
    if (!sess.db) return myErr(1046, '3D000', 'No database selected')
    const inst = s.dbs.get(sess.db)
    if (!inst) return { kind: 'rows', columns: [`Tables_in_${sess.db}`], rows: [] }
    materialize(s, inst)
    return { kind: 'rows', columns: [`Tables_in_${sess.db}`], rows: [...inst.ddl.keys()].sort().filter((t) => hasPriv(sess, 'SELECT', sess.db!, t) || anyPrivOn(sess, sess.db!)).map((t) => [t]) }
  }
  if ((m = /^(?:DESC|DESCRIBE|SHOW (?:FULL )?COLUMNS FROM|SHOW FIELDS FROM) ([`"]?[\w.]+[`"]?)/i.exec(stmt))) {
    return describe(sess, unquote(m[1]))
  }
  if ((m = /^SHOW CREATE TABLE ([`"]?[\w.]+[`"]?)/i.exec(stmt))) {
    const t = unquote(m[1])
    const inst = sess.db ? s.dbs.get(sess.db) : undefined
    const ddl = inst?.ddl.get(t)
    if (!ddl) return myErr(1146, '42S02', `Table '${sess.db}.${t}' doesn't exist`)
    return { kind: 'rows', columns: ['Table', 'Create Table'], rows: [[t, mysqlDdl(ddl)]] }
  }
  if ((m = /^SHOW (?:INDEX|INDEXES|KEYS) FROM ([`"]?\w+[`"]?)/i.exec(stmt))) {
    const t = unquote(m[1])
    const inst = sess.db ? s.dbs.get(sess.db) : undefined
    if (!inst?.ddl.has(t)) return myErr(1146, '42S02', `Table '${sess.db}.${t}' doesn't exist`)
    const rows: unknown[][] = []
    const info = materialize(s, inst)?.exec(`PRAGMA table_info(${t})`)[0]?.values ?? []
    const pk = info.find((r) => Number(r[5]) > 0)?.[1] as string | undefined
    if (pk) rows.push([t, 0, 'PRIMARY', 1, pk, 'A', count(s, inst, t), null, null, '', 'BTREE'])
    for (const [k, v] of inst.indexes) {
      if (v.table !== t) continue
      v.columns.forEach((c, i) => {
        let card = count(s, inst, t)
        try {
          card = Number(materialize(s, inst)?.exec(`SELECT count(DISTINCT ${c}) FROM ${t}`)[0]?.values[0]?.[0] ?? card)
        } catch {
          // columna con expresión
        }
        const nullable = info.find((r) => r[1] === c)?.[3] ? '' : 'YES'
        rows.push([t, v.unique ? 0 : 1, k, i + 1, c, 'A', card, null, null, nullable, 'BTREE'])
      })
    }
    return { kind: 'rows', columns: ['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null', 'Index_type'], rows }
  }
  if (/^EXPLAIN\b/.test(U) && !/^EXPLAIN (FORMAT|ANALYZE)/.test(U)) return explainMy(sess, stmt.replace(/^EXPLAIN\s+/i, ''))
  if ((m = /^CREATE USER (IF NOT EXISTS )?(.+?)(?: IDENTIFIED (?:BY|VIA \w+ USING PASSWORD\() ?'([^']*)'\)?)?$/is.exec(stmt))) {
    if (!sess.user.superuser) return denied('CREATE USER')
    const acc = parseAccount(m[2])
    if (findUser(s, acc.name, acc.host)) return m[1] ? { kind: 'ok', affected: 0, warnings: 1 } : myErr(1396, 'HY000', `Operation CREATE USER failed for '${acc.name}'@'${acc.host}'`)
    s.users.push({ name: acc.name, host: acc.host, password: m[3], plugin: 'password', superuser: false, login: true, createdb: false })
    syncMysqlUserTable(s)
    return { kind: 'ok', affected: 0 }
  }
  if ((m = /^(?:ALTER USER (.+?) IDENTIFIED BY|SET PASSWORD FOR (.+?) = PASSWORD\() ?'([^']*)'\)?$/is.exec(stmt))) {
    if (!sess.user.superuser) return denied('CREATE USER')
    const acc = parseAccount(m[1] ?? m[2])
    const u = findUser(s, acc.name, acc.host)
    if (!u) return myErr(1396, 'HY000', `Operation ALTER USER failed for '${acc.name}'@'${acc.host}'`)
    u.password = m[3]
    u.plugin = 'password'
    return { kind: 'ok', affected: 0 }
  }
  if ((m = /^DROP USER (IF EXISTS )?(.+)$/is.exec(stmt))) {
    if (!sess.user.superuser) return denied('CREATE USER')
    for (const a of m[2].split(',')) {
      const acc = parseAccount(a)
      const u = findUser(s, acc.name, acc.host)
      if (!u) {
        if (m[1]) continue
        return myErr(1396, 'HY000', `Operation DROP USER failed for '${acc.name}'@'${acc.host}'`)
      }
      s.users = s.users.filter((x) => x !== u)
      s.grants = s.grants.filter((g) => g.user !== accountKey(u, 'mariadb'))
    }
    syncMysqlUserTable(s)
    return { kind: 'ok', affected: 0 }
  }
  if ((m = /^GRANT (.+?) ON (?:TABLE )?([`"]?[\w*]+[`"]?)\.([`"]?[\w*]+[`"]?) TO (.+?)(?: IDENTIFIED BY '([^']*)')?( WITH GRANT OPTION)?$/is.exec(stmt))) {
    if (!sess.user.superuser) return denied('GRANT OPTION')
    const acc = parseAccount(m[4])
    let u = findUser(s, acc.name, acc.host)
    if (!u && m[5]) {
      u = { name: acc.name, host: acc.host, password: m[5], plugin: 'password', superuser: false, login: true, createdb: false }
      s.users.push(u)
      syncMysqlUserTable(s)
    }
    if (!u) return myErr(1133, '28000', "Can't find any matching row in the user table")
    const db = unquote(m[2])
    const table = unquote(m[3])
    const key = accountKey(u, 'mariadb')
    const g = s.grants.find((x) => x.user === key && x.db === db && x.table === table)
    const privs = privList(m[1], 'mariadb')
    if (g) for (const p of privs) g.privs.add(p)
    else s.grants.push({ user: key, db, table, privs, grantOption: !!m[6] })
    if (db === '*' && privs.has('ALL') && m[6]) u.superuser = true
    return { kind: 'ok', affected: 0 }
  }
  if ((m = /^REVOKE (.+?) ON (?:TABLE )?([`"]?[\w*]+[`"]?)\.([`"]?[\w*]+[`"]?) FROM (.+)$/is.exec(stmt))) {
    if (!sess.user.superuser) return denied('GRANT OPTION')
    const acc = parseAccount(m[4])
    const u = findUser(s, acc.name, acc.host)
    if (!u) return myErr(1133, '28000', "Can't find any matching row in the user table")
    const key = accountKey(u, 'mariadb')
    const g = s.grants.find((x) => x.user === key && x.db === unquote(m![2]) && x.table === unquote(m![3]))
    if (!g) return myErr(1141, '42000', `There is no such grant defined for user '${u.name}' on host '${u.host}'`)
    const privs = privList(m[1], 'mariadb')
    if (privs.has('ALL')) g.privs.clear()
    else for (const p of privs) g.privs.delete(p)
    return { kind: 'ok', affected: 0 }
  }
  if ((m = /^SHOW GRANTS(?: FOR (.+))?$/is.exec(stmt))) {
    const acc = m[1] && !/^CURRENT_USER/i.test(m[1]) ? parseAccount(m[1]) : { name: sess.user.name, host: sess.user.host }
    const u = findUser(s, acc.name, acc.host)
    if (!u) return myErr(1141, '42000', `There is no such grant defined for user '${acc.name}' on host '${acc.host}'`)
    if (!sess.user.superuser && u !== sess.user) return myErr(1044, '42000', `Access denied for user '${sess.user.name}'@'${sess.user.host}' to database 'mysql'`)
    return { kind: 'rows', columns: [`Grants for ${u.name}@${u.host}`], rows: grantsOf(s, u).map((g) => [g]) }
  }
  if (/^FLUSH PRIVILEGES/.test(U)) return { kind: 'ok', affected: 0 }
  if (/^FLUSH (BINARY )?LOGS/.test(U)) {
    if (!sess.user.superuser) return denied('RELOAD')
    rotateBinlog(s)
    return { kind: 'ok', affected: 0 }
  }
  if (/^SHOW (BINARY|MASTER) LOGS/.test(U)) {
    if (!s.loaded?.logBin) return myErr(1381, 'HY000', 'You are not using binary logging')
    return { kind: 'rows', columns: ['Log_name', 'File_size'], rows: s.binlog.map((f) => [f.name, f.size]) }
  }
  if (/^SHOW (MASTER|BINLOG) STATUS/.test(U)) {
    const f = s.binlog.at(-1)
    if (!s.loaded?.logBin || !f) return { kind: 'rows', columns: ['File', 'Position', 'Binlog_Do_DB', 'Binlog_Ignore_DB'], rows: [] }
    return { kind: 'rows', columns: ['File', 'Position', 'Binlog_Do_DB', 'Binlog_Ignore_DB'], rows: [[f.name, f.size, '', '']] }
  }
  if (/^SHOW (SLAVE|REPLICA) STATUS/.test(U)) return { kind: 'rows', columns: [], rows: [] }
  if ((m = /^SHOW (?:GLOBAL |SESSION )?VARIABLES(?: LIKE '([^']*)')?/i.exec(stmt))) {
    const re = m[1] ? new RegExp('^' + m[1].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i') : /./
    return { kind: 'rows', columns: ['Variable_name', 'Value'], rows: Object.entries(variables(s)).filter(([k]) => re.test(k)).map(([k, v]) => [k, v]) }
  }
  if ((m = /^SHOW (?:GLOBAL )?STATUS(?: LIKE '([^']*)')?/i.exec(stmt))) {
    const st: Record<string, string> = { Threads_connected: '3', Uptime: '86412', Questions: '182934', Slow_queries: '12', Connections: '4521', Aborted_connects: '7', Max_used_connections: '41' }
    const re = m[1] ? new RegExp('^' + m[1].replace(/%/g, '.*') + '$', 'i') : /./
    return { kind: 'rows', columns: ['Variable_name', 'Value'], rows: Object.entries(st).filter(([k]) => re.test(k)).map(([k, v]) => [k, v]) }
  }
  if (/^SHOW (FULL )?PROCESSLIST/.test(U)) {
    return { kind: 'rows', columns: ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info', 'Progress'], rows: [[s.thread, sess.user.name, sess.from === 'localhost' ? 'localhost' : `${sess.from}:51122`, sess.db ?? null, 'Query', 0, 'starting', 'SHOW PROCESSLIST', '0.000']] }
  }
  if (/^SELECT .* FROM MYSQL\.USER\b/.test(U) || /^SELECT .* FROM `?MYSQL`?\.`?USER`?/.test(U)) {
    if (!sess.user.superuser) return myErr(1142, '42000', `SELECT command denied to user '${sess.user.name}'@'${sess.user.host}' for table \`mysql\`.\`user\``)
    syncMysqlUserTable(s)
    const inst = s.dbs.get('mysql')!
    const db = materialize(s, inst)
    if (!db) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando.' }
    try {
      const r = db.exec(stmt.replace(/`?mysql`?\.`?user`?/i, 'user'))
      return { kind: 'rows', columns: r[0]?.columns ?? columnsOf(stmt), rows: r[0]?.values ?? [] }
    } catch (e) {
      return translateError(sess, stmt, e)
    }
  }
  if (/^SELECT\b/.test(U) && !/\bFROM\b/.test(U)) {
    // SELECT VERSION(), SELECT NOW(), SELECT 1+1: se resuelven con SQLite sin base.
    const SQL = sqlReady()
    if (!SQL) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando.' }
    const tmp = new SQL.Database()
    try {
      const r = tmp.exec(toSqlite('mariadb', stmt, sess))
      const cols = stmt.replace(/^SELECT\s+/i, '').split(/,(?![^(]*\))/).map((c) => c.trim().replace(/\s+AS\s+(\w+)$/i, '$1'))
      return { kind: 'rows', columns: r[0]?.columns.map((c, i) => (/^'/.test(c) || c.length > 40 ? cols[i] ?? c : cols[i] ?? c)) ?? cols, rows: r[0]?.values ?? [] }
    } catch (e) {
      return translateError(sess, stmt, e)
    } finally {
      tmp.close()
    }
  }
  if (/^(CHANGE MASTER|CHANGE REPLICATION)/.test(U)) return { kind: 'ok', affected: 0 }
  if (/^(SHOW|START (SLAVE|REPLICA)|STOP (SLAVE|REPLICA)|RESET|PURGE|INSTALL|UNINSTALL|CREATE (FUNCTION|PROCEDURE|TRIGGER|EVENT)|DELIMITER|CALL)\b/.test(U)) {
    return { kind: 'error', text: `[simulador] "${stmt.split(/\s+/).slice(0, 3).join(' ')}" no está simulado. Probalo en tu laboratorio con MariaDB real.` }
  }
  return undefined
}

function count(s: DbServer, inst: DbInstance, t: string): number {
  try {
    return Number(materialize(s, inst)?.exec(`SELECT count(*) FROM ${t}`)[0]?.values[0]?.[0] ?? 0)
  } catch {
    return 0
  }
}

/** pg_database, pg_roles y pg_user (las columnas más usadas), como tablas temporales. */
function syncPgCatalog(s: DbServer, db: SqlDatabase) {
  db.run('DROP TABLE IF EXISTS temp.pg_database')
  db.run('DROP TABLE IF EXISTS temp.pg_roles')
  db.run('DROP TABLE IF EXISTS temp.pg_user')
  db.run('CREATE TEMP TABLE pg_database (datname TEXT, datdba TEXT, encoding TEXT, datistemplate INTEGER, datallowconn INTEGER)')
  db.run('CREATE TEMP TABLE pg_roles (rolname TEXT, rolsuper INTEGER, rolcreatedb INTEGER, rolcanlogin INTEGER, rolpassword TEXT)')
  db.run('CREATE TEMP TABLE pg_user (usename TEXT, usesuper INTEGER, usecreatedb INTEGER, passwd TEXT)')
  const names = new Set([...s.dbs.keys()])
  for (const t of ['postgres', 'template0', 'template1']) names.add(t)
  for (const n of [...names].sort()) db.run('INSERT INTO pg_database VALUES (?,?,?,?,?)', [n, s.dbs.get(n)?.owner ?? 'postgres', 'UTF8', n.startsWith('template') ? 1 : 0, n === 'template0' ? 0 : 1])
  for (const u of s.users) {
    db.run('INSERT INTO pg_roles VALUES (?,?,?,?,?)', [u.name, u.superuser ? 1 : 0, u.createdb ? 1 : 0, u.login ? 1 : 0, '********'])
    if (u.login) db.run('INSERT INTO pg_user VALUES (?,?,?,?)', [u.name, u.superuser ? 1 : 0, u.createdb ? 1 : 0, '********'])
  }
}

/** La tabla mysql.user, para poder consultarla con SELECT. */
function syncMysqlUserTable(s: DbServer) {
  let inst = s.dbs.get('mysql')
  if (!inst) inst = newDb(s, 'mysql', 'root')
  const db = materialize(s, inst)
  if (!db) return
  db.run('DROP TABLE IF EXISTS user')
  db.run('CREATE TABLE user (Host TEXT, User TEXT, plugin TEXT, authentication_string TEXT, Super_priv TEXT)')
  for (const u of s.users) db.run('INSERT INTO user VALUES (?,?,?,?,?)', [u.host, u.name, u.plugin === 'unix_socket' ? 'unix_socket' : 'mysql_native_password', u.password ? mysqlHash(u.password) : u.plugin === 'unix_socket' ? 'invalid' : '', u.superuser ? 'Y' : 'N'])
  inst.ddl.set('user', 'CREATE TABLE user (...)')
}

export function mysqlHash(p: string): string {
  let h = 0x811c9dc5
  for (const c of p) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  let out = ''
  for (let i = 0; i < 5; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return '*' + out.toUpperCase()
}

export function grantsOf(s: DbServer, u: DbUser): string[] {
  const key = accountKey(u, 'mariadb')
  const acc = `\`${u.name}\`@\`${u.host}\``
  const out: string[] = []
  const global = s.grants.find((g) => g.user === key && g.db === '*' && g.table === '*')
  const pw = u.plugin === 'unix_socket' ? ' IDENTIFIED VIA mysql_native_password USING \'invalid\' OR unix_socket' : u.password ? ` IDENTIFIED BY PASSWORD '${mysqlHash(u.password)}'` : ''
  const gp = (g?: Grant) => (!g || !g.privs.size ? 'USAGE' : g.privs.has('ALL') ? 'ALL PRIVILEGES' : [...g.privs].join(', '))
  out.push(`GRANT ${u.superuser && u.name === 'root' ? 'ALL PRIVILEGES' : gp(global)} ON *.* TO ${acc}${pw}${global?.grantOption || (u.superuser && u.name === 'root') ? ' WITH GRANT OPTION' : ''}`)
  for (const g of s.grants.filter((x) => x.user === key && !(x.db === '*' && x.table === '*') && x.privs.size)) {
    out.push(`GRANT ${gp(g)} ON \`${g.db}\`.${g.table === '*' ? '*' : `\`${g.table}\``} TO ${acc}${g.grantOption ? ' WITH GRANT OPTION' : ''}`)
  }
  return out
}

function bytes(v: string): string {
  const m = /^(\d+)\s*([KMG])?$/i.exec(v.trim())
  if (!m) return v
  return String(Number(m[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[(m[2] ?? '').toUpperCase() as 'K'] ?? 1))
}

function variables(s: DbServer): Record<string, string> {
  const c = s.loaded
  const extra: Record<string, string> = {}
  for (const [k, v] of c?.raw ?? []) if (/^(innodb_|max_|tmp_table|query_|table_|thread_|wait_timeout|key_buffer)/.test(k)) extra[k] = /size$|_buffer/.test(k) ? bytes(v) : v
  return {
    basedir: '/usr',
    bind_address: c?.bind ?? '',
    binlog_format: 'MIXED',
    character_set_server: s.sys.distro === 'rocky' ? 'latin1' : 'utf8mb4',
    datadir: '/var/lib/mysql/',
    innodb_buffer_pool_size: '134217728',
    log_bin: c?.logBin ? 'ON' : 'OFF',
    log_bin_basename: c?.logBin ?? '',
    long_query_time: (c?.longQueryTime ?? 10).toFixed(6),
    max_connections: String(c?.maxConnections ?? 151),
    port: String(c?.port ?? 3306),
    server_id: String(c?.serverId ?? 1),
    skip_networking: 'OFF',
    slow_query_log: c?.slowLog ? 'ON' : 'OFF',
    slow_query_log_file: c?.raw?.get('slow_query_log_file') ?? `${s.sys.hostname}-slow.log`,
    socket: s.sys.distro === 'rocky' ? '/var/lib/mysql/mysql.sock' : '/run/mysqld/mysqld.sock',
    version: versionOf(s.sys, 'mariadb'),
    ...extra,
  }
}

/** CREATE TABLE con el estilo de MariaDB para SHOW CREATE TABLE y mysqldump. */
export function mysqlDdl(ddl: string): string {
  let d = ddl.trim().replace(/;\s*$/, '')
  if (!/\bENGINE\s*=/i.test(d)) d += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'
  return d
}

function describe(sess: Session, table: string): Result {
  const s = sess.server
  const inst = sess.db ? s.dbs.get(sess.db) : undefined
  if (!sess.db) return myErr(1046, '3D000', 'No database selected')
  const db = inst ? materialize(s, inst) : undefined
  if (!inst || !db || !inst.ddl.has(table)) return myErr(1146, '42S02', `Table '${sess.db}.${table}' doesn't exist`)
  if (!hasPriv(sess, 'SELECT', sess.db, table) && !anyPrivOn(sess, sess.db)) return myErr(1142, '42000', `SELECT command denied to user '${sess.user.name}'@'${sess.user.host}' for table \`${sess.db}\`.\`${table}\``)
  const info = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []
  const ddl = inst.ddl.get(table)!
  const idxCols = new Map<string, string>()
  for (const v of inst.indexes.values()) if (v.table === table) idxCols.set(v.columns[0], v.unique ? 'UNI' : 'MUL')
  return {
    kind: 'rows',
    columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
    rows: info.map((r) => {
      const name = String(r[1])
      const colDef = new RegExp('[`"]?' + name + '[`"]?\\s+([^,\\n]+)', 'i').exec(ddl)?.[1] ?? ''
      const auto = /AUTO_INCREMENT|SERIAL/i.test(colDef)
      let type = String(r[2]).toLowerCase()
      if (type === 'integer') type = 'int(11)'
      if (/^int\b/.test(type) && !/\(/.test(type)) type = 'int(11)'
      if (/^varchar|^char|^decimal/.test(type) === false && /^(\w+)\s*\(/.test(colDef)) type = (/^(\w+\s*\([^)]*\))/.exec(colDef)?.[1] ?? type).toLowerCase()
      return [name, type, r[3] || r[5] ? 'NO' : 'YES', r[5] ? 'PRI' : (idxCols.get(name) ?? ''), r[4] === null ? 'NULL' : String(r[4]).replace(/^'|'$/g, '').replace(/^CURRENT_TIMESTAMP$/i, 'current_timestamp()'), auto ? 'auto_increment' : '']
    }),
  }
}

function explainMy(sess: Session, query: string): Result {
  const s = sess.server
  if (!sess.db) return myErr(1046, '3D000', 'No database selected')
  const inst = s.dbs.get(sess.db)!
  const db = materialize(s, inst)
  if (!db) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando.' }
  let plan: unknown[][]
  try {
    plan = db.exec('EXPLAIN QUERY PLAN ' + toSqlite('mariadb', query, sess))[0]?.values ?? []
  } catch (e) {
    return translateError(sess, query, e)
  }
  const rows = plan.map((p, i) => {
    const detail = String(p[3])
    const t = /(?:SCAN|SEARCH) (\w+)/.exec(detail)?.[1] ?? ''
    const idx = /USING (?:COVERING )?INDEX (\w+)/.exec(detail)?.[1]
    const pk = /USING INTEGER PRIMARY KEY/.test(detail)
    const total = count(s, inst, t)
    const possible = [...inst.indexes.entries()].filter(([, v]) => v.table === t).map(([k]) => k)
    if (pk) return [i + 1, 'SIMPLE', t, 'const', 'PRIMARY', 'PRIMARY', '4', 'const', 1, '']
    if (idx) {
      const col = inst.indexes.get(idx)?.columns[0] ?? ''
      let distinct: number
      try {
        distinct = Number(db.exec(`SELECT count(DISTINCT ${col}) FROM ${t}`)[0]?.values[0]?.[0] ?? 1) || 1
      } catch {
        distinct = 50
      }
      const def = new RegExp('[`"]?' + col + '[`"]?\\s+(\\w+)\\s*(?:\\((\\d+)\\))?', 'i').exec(inst.ddl.get(t) ?? '')
      const ty = (def?.[1] ?? 'int').toLowerCase()
      const keyLen = /^big/.test(ty) ? 8 : /int/.test(ty) ? 4 : /^date$/.test(ty) ? 3 : /datetime|timestamp/.test(ty) ? 5 : /char/.test(ty) ? Number(def?.[2] ?? 50) * 4 + 2 : 8
      return [i + 1, 'SIMPLE', t, 'ref', possible.join(',') || idx, idx, String(keyLen), 'const', Math.max(1, Math.round(total / distinct)), '']
    }
    return [i + 1, 'SIMPLE', t, 'ALL', possible.length ? possible.join(',') : null, null, null, null, total, /WHERE/i.test(query) ? 'Using where' : '']
  })
  return { kind: 'rows', columns: ['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'Extra'], rows }
}

// ---------------------------------------------------------------------------------------
// Sentencias propias de PostgreSQL
// ---------------------------------------------------------------------------------------

function pgSpecial(sess: Session, raw: string): Result | undefined {
  const stmt = raw.replace(/\s+/g, ' ').trim()
  const s = sess.server
  const U = stmt.toUpperCase().replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  const mustSuper = (what: string) => pgErr(`permission denied to ${what}`)

  if (/^(SET|SELECT PG_CATALOG\.SET_CONFIG|COMMENT ON|ALTER SCHEMA|CREATE EXTENSION|ANALYZE|VACUUM)\b/.test(U)) {
    if (/^ANALYZE|^VACUUM/.test(U)) return { kind: 'ok', affected: 0, tag: U.split(' ')[0] }
    return { kind: 'ok', affected: 0, tag: U.startsWith('SELECT') ? 'SELECT 1' : U.startsWith('COMMENT') ? 'COMMENT' : 'SET' }
  }
  if (/^(BEGIN|START TRANSACTION|COMMIT|ROLLBACK|END)\b/.test(U)) {
    const db = sess.db ? materialize(s, s.dbs.get(sess.db)!) : undefined
    try {
      db?.run(U.startsWith('START') || U.startsWith('BEGIN') ? 'BEGIN' : U.startsWith('END') ? 'COMMIT' : U.split(' ')[0])
    } catch {
      // ya abierta o cerrada
    }
    return { kind: 'ok', affected: 0, tag: U.startsWith('START') ? 'BEGIN' : U.startsWith('END') ? 'COMMIT' : U.split(' ')[0] }
  }
  if ((m = /^CREATE (?:ROLE|USER) ("?\w+"?)(?: WITH)?(.*)$/is.exec(stmt))) {
    if (!sess.user.superuser && !sess.user.createdb) return mustSuper('create role')
    const name = unquote(m[1])
    if (findUser(s, name)) return pgErr(`role "${name}" already exists`)
    const opts = m[2]
    const pw = /PASSWORD\s+'([^']*)'/i.exec(opts)?.[1]
    s.users.push({ name, host: '', password: pw, plugin: 'password', superuser: /\bSUPERUSER\b/i.test(opts), login: /^CREATE USER/i.test(stmt) || /\bLOGIN\b/i.test(opts.replace(/NOLOGIN/i, '')), createdb: /\bCREATEDB\b/i.test(opts) })
    return { kind: 'ok', affected: 0, tag: 'CREATE ROLE' }
  }
  if ((m = /^ALTER (?:ROLE|USER) ("?\w+"?)(?: WITH)?(.*)$/is.exec(stmt))) {
    const name = unquote(m[1])
    const u = findUser(s, name)
    if (!u) return pgErr(`role "${name}" does not exist`)
    if (!sess.user.superuser && u !== sess.user) return mustSuper('alter role')
    const opts = m[2]
    const pw = /PASSWORD\s+'([^']*)'/i.exec(opts)?.[1]
    if (pw !== undefined) u.password = pw
    if (/\bNOLOGIN\b/i.test(opts)) u.login = false
    else if (/\bLOGIN\b/i.test(opts)) u.login = true
    if (/\bNOSUPERUSER\b/i.test(opts)) u.superuser = false
    else if (/\bSUPERUSER\b/i.test(opts)) u.superuser = true
    if (/\bCREATEDB\b/i.test(opts)) u.createdb = true
    return { kind: 'ok', affected: 0, tag: 'ALTER ROLE' }
  }
  if ((m = /^DROP (?:ROLE|USER) (IF EXISTS )?("?\w+"?)$/is.exec(stmt))) {
    if (!sess.user.superuser) return mustSuper('drop role')
    const name = unquote(m[2])
    const u = findUser(s, name)
    if (!u) return m[1] ? { kind: 'ok', affected: 0, tag: 'DROP ROLE' } : pgErr(`role "${name}" does not exist`)
    const owns = [...s.dbs.values()].find((d) => d.owner === name)
    if (owns) return pgErr(`role "${name}" cannot be dropped because some objects depend on it`, `DETAIL:  owner of database ${owns.name}`)
    s.users = s.users.filter((x) => x !== u)
    s.grants = s.grants.filter((g) => g.user !== name)
    return { kind: 'ok', affected: 0, tag: 'DROP ROLE' }
  }
  if ((m = /^CREATE DATABASE ("?\w+"?)(.*)$/is.exec(stmt))) {
    if (!sess.user.superuser && !sess.user.createdb) return pgErr('permission denied to create database')
    const name = unquote(m[1])
    if (s.dbs.has(name)) return pgErr(`database "${name}" already exists`)
    const owner = /OWNER\s*=?\s*("?\w+"?)/i.exec(m[2])?.[1]
    if (owner && !findUser(s, unquote(owner))) return pgErr(`role "${unquote(owner)}" does not exist`)
    newDb(s, name, owner ? unquote(owner) : sess.user.name)
    return { kind: 'ok', affected: 0, tag: 'CREATE DATABASE' }
  }
  if ((m = /^DROP DATABASE (IF EXISTS )?("?\w+"?)/i.exec(stmt))) {
    const name = unquote(m[2])
    const inst = s.dbs.get(name)
    if (!inst) return m[1] ? { kind: 'ok', affected: 0, tag: 'DROP DATABASE' } : pgErr(`database "${name}" does not exist`)
    if (!sess.user.superuser && inst.owner !== sess.user.name) return pgErr(`must be owner of database ${name}`)
    if (sess.db === name) return pgErr('cannot drop the currently open database')
    inst.db?.close()
    s.dbs.delete(name)
    s.grants = s.grants.filter((g) => g.db !== name)
    return { kind: 'ok', affected: 0, tag: 'DROP DATABASE' }
  }
  if ((m = /^ALTER DATABASE ("?\w+"?) OWNER TO ("?\w+"?)/i.exec(stmt))) {
    const inst = s.dbs.get(unquote(m[1]))
    if (!inst) return pgErr(`database "${unquote(m[1])}" does not exist`)
    if (!sess.user.superuser) return pgErr(`must be owner of database ${inst.name}`)
    inst.owner = unquote(m[2])
    return { kind: 'ok', affected: 0, tag: 'ALTER DATABASE' }
  }
  if ((m = /^ALTER TABLE (?:ONLY )?("?[\w.]+"?) OWNER TO ("?\w+"?)/i.exec(stmt))) {
    const inst = sess.db ? s.dbs.get(sess.db) : undefined
    if (inst) inst.tableOwner.set(unquote(m[1]).split('.').pop()!, unquote(m[2]))
    return { kind: 'ok', affected: 0, tag: 'ALTER TABLE' }
  }
  if (/^ALTER TABLE .* (ADD CONSTRAINT .* PRIMARY KEY|ALTER COLUMN .* SET DEFAULT NEXTVAL)/i.test(stmt) || /^(CREATE|ALTER) SEQUENCE|^SELECT PG_CATALOG\.SETVAL/i.test(U)) {
    return { kind: 'ok', affected: 0, tag: U.startsWith('SELECT') ? 'SELECT 1' : U.split(' ').slice(0, 2).join(' ') }
  }
  if ((m = /^ALTER DEFAULT PRIVILEGES(?: FOR (?:ROLE|USER) \w+)?(?: IN SCHEMA \w+)? GRANT (.+?) ON TABLES TO ("?\w+"?)/i.exec(stmt))) {
    const inst = sess.db ? s.dbs.get(sess.db) : undefined
    if (inst) inst.defaultPrivs.push({ user: unquote(m[2]), privs: privList(m[1], 'postgres') })
    return { kind: 'ok', affected: 0, tag: 'ALTER DEFAULT PRIVILEGES' }
  }
  if ((m = /^(GRANT|REVOKE) (.+?) ON (DATABASE|SCHEMA|ALL TABLES IN SCHEMA|TABLE|ALL SEQUENCES IN SCHEMA|SEQUENCE)?\s*([\w"., ]+?) (?:TO|FROM) ("?\w+"?)$/is.exec(stmt))) {
    const grant = m[1].toUpperCase() === 'GRANT'
    const target = (m[3] ?? 'TABLE').toUpperCase()
    const user = unquote(m[5])
    if (user.toUpperCase() !== 'PUBLIC' && !findUser(s, user)) return pgErr(`role "${user}" does not exist`)
    const privs = privList(m[2], 'postgres')
    const tag = grant ? 'GRANT' : 'REVOKE'
    if (/SEQUENCE/.test(target)) return { kind: 'ok', affected: 0, tag }
    if (target === 'DATABASE') {
      const name = unquote(m[4])
      const inst = s.dbs.get(name)
      if (!inst) return pgErr(`database "${name}" does not exist`)
      if (!sess.user.superuser && inst.owner !== sess.user.name) return pgErr(`permission denied for database ${name}`)
      // CONNECT lo tiene PUBLIC de fábrica; CREATE en la base no da permiso en el esquema public.
      return { kind: 'ok', affected: 0, tag }
    }
    if (!sess.db) return pgErr('no database selected')
    const inst = s.dbs.get(sess.db)!
    if (target === 'SCHEMA') {
      if (!sess.user.superuser && inst.owner !== sess.user.name) return pgErr('permission denied for schema public')
      if (privs.has('CREATE') || privs.has('ALL')) {
        if (grant) inst.schemaCreate.add(user)
        else inst.schemaCreate.delete(user)
      }
      return { kind: 'ok', affected: 0, tag }
    }
    const tables = target === 'ALL TABLES IN SCHEMA' ? [...inst.ddl.keys()] : m[4].split(',').map((t) => unquote(t.trim()).split('.').pop()!)
    for (const t of tables) {
      if (!inst.ddl.has(t)) return pgErr(`relation "${t}" does not exist`)
      if (!sess.user.superuser && inst.tableOwner.get(t) !== sess.user.name) return pgErr(`permission denied for table ${t}`)
      const all = privs.has('ALL') ? new Set(ALL_PG_TABLE) : privs
      let g = s.grants.find((x) => x.user === user && x.db === inst.name && x.table === t)
      if (!g && grant) {
        g = { user, db: inst.name, table: t, privs: new Set(), grantOption: false }
        s.grants.push(g)
      }
      if (g) {
        for (const p of all) {
          if (grant) g.privs.add(p)
          else g.privs.delete(p)
        }
      }
    }
    return { kind: 'ok', affected: 0, tag }
  }
  if (/^EXPLAIN\b/.test(U)) return explainPg(sess, stmt.replace(/^EXPLAIN\s+(ANALYZE\s+)?/i, ''), /^EXPLAIN ANALYZE/.test(U))
  if ((m = /^SHOW (\w+)$/i.exec(stmt))) {
    const c = s.loaded
    const vals: Record<string, string> = { server_version: versionOf(s.sys, 'postgres').split(' ')[0], listen_addresses: c?.listen ?? 'localhost', port: String(c?.port ?? 5432), max_connections: String(c?.maxConnections ?? 100), data_directory: pgDataDir(s.sys), hba_file: `${pgConfDir(s.sys)}/pg_hba.conf`, config_file: `${pgConfDir(s.sys)}/postgresql.conf`, shared_buffers: '128MB', wal_level: 'replica', archive_mode: 'off', log_min_duration_statement: '-1', password_encryption: 'scram-sha-256' }
    const v = vals[m[1].toLowerCase()]
    if (v === undefined) return pgErr(`unrecognized configuration parameter "${m[1]}"`)
    return { kind: 'rows', columns: [m[1].toLowerCase()], rows: [[v]] }
  }
  if (/^SELECT\b/.test(U) && /\bPG_STAT_ACTIVITY\b/.test(U)) {
    return { kind: 'rows', columns: ['pid', 'usename', 'datname', 'client_addr', 'state', 'query'], rows: [[41233, sess.user.name, sess.db ?? '', sess.from === 'localhost' ? null : sess.from, 'active', stmt.slice(0, 60)]] }
  }
  if (/^SELECT\b/.test(U) && /\bPG_DATABASE_SIZE\b|\bPG_SIZE_PRETTY\b/.test(U)) {
    return { kind: 'rows', columns: ['pg_size_pretty'], rows: [['7612 kB']] }
  }
  if (/^SELECT\b/.test(U) && !/\bFROM\b/.test(U)) {
    const SQL = sqlReady()
    if (!SQL) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando.' }
    const tmp = new SQL.Database()
    try {
      const r = tmp.exec(toSqlite('postgres', stmt, sess))
      const names = stmt.replace(/^SELECT\s+/i, '').split(/,(?![^(]*\))/).map((c) => {
        const as = /\s+AS\s+(\w+)$/i.exec(c.trim())
        return as ? as[1] : (/^(\w+)\s*\(/.exec(c.trim())?.[1]?.toLowerCase() ?? '?column?')
      })
      return { kind: 'rows', columns: names, rows: r[0]?.values ?? [] }
    } catch (e) {
      return translateError(sess, stmt, e)
    } finally {
      tmp.close()
    }
  }
  if (/^(CREATE (FUNCTION|PROCEDURE|TRIGGER|PUBLICATION|SUBSCRIPTION)|CHECKPOINT|LISTEN|NOTIFY|CLUSTER|REINDEX|COPY .* TO)\b/.test(U)) {
    return { kind: 'error', text: `[simulador] "${stmt.split(/\s+/).slice(0, 3).join(' ')}" no está simulado. Probalo en tu laboratorio con PostgreSQL real.` }
  }
  return undefined
}

function explainPg(sess: Session, query: string, analyze: boolean): Result {
  const s = sess.server
  if (!sess.db) return pgErr('no database selected')
  const inst = s.dbs.get(sess.db)!
  const db = materialize(s, inst)
  if (!db) return { kind: 'error', text: '[simulador] El motor de la base todavía se está cargando.' }
  let plan: unknown[][]
  try {
    plan = db.exec('EXPLAIN QUERY PLAN ' + toSqlite('postgres', query, sess))[0]?.values ?? []
  } catch (e) {
    return translateError(sess, query, e)
  }
  const lines: string[] = []
  for (const p of plan) {
    const detail = String(p[3])
    const t = /(?:SCAN|SEARCH) (\w+)/.exec(detail)?.[1] ?? ''
    const idx = /USING (?:COVERING )?INDEX (\w+)/.exec(detail)?.[1] ?? (/USING INTEGER PRIMARY KEY/.test(detail) ? `${t}_pkey` : undefined)
    const total = count(s, inst, t)
    const where = /WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i.exec(query)?.[1]
    if (idx) lines.push(`Index Scan using ${idx} on ${t}  (cost=0.29..8.31 rows=1 width=64)${analyze ? ' (actual time=0.021..0.023 rows=1 loops=1)' : ''}`, ...(where ? [`  Index Cond: (${where})`] : []))
    else if (t) lines.push(`Seq Scan on ${t}  (cost=0.00..${(total / 50).toFixed(2)} rows=${where ? Math.max(1, Math.round(total / 100)) : total} width=64)${analyze ? ` (actual time=0.012..${(total / 900).toFixed(3)} rows=${where ? 1 : total} loops=1)` : ''}`, ...(where ? [`  Filter: (${where})`, ...(analyze ? [`  Rows Removed by Filter: ${Math.max(0, total - 1)}`] : [])] : []))
  }
  if (analyze) lines.push('Planning Time: 0.080 ms', `Execution Time: ${(lines.some((l) => l.startsWith('Seq')) ? 4.512 : 0.041).toFixed(3)} ms`)
  return { kind: 'rows', columns: ['QUERY PLAN'], rows: lines.map((l) => [l]) }
}

// ---------------------------------------------------------------------------------------
// Rutas de PostgreSQL según la distribución
// ---------------------------------------------------------------------------------------

export function pgDataDir(sys: System): string {
  return sys.distro === 'rocky' ? '/var/lib/pgsql/data' : `/var/lib/postgresql/${pgMajor(sys)}/main`
}

export function pgConfDir(sys: System): string {
  return sys.distro === 'rocky' ? '/var/lib/pgsql/data' : `/etc/postgresql/${pgMajor(sys)}/main`
}

/** Las tablas de una base, para \dt y los volcados. */
export function tablesOf(s: DbServer, inst: DbInstance): string[] {
  materialize(s, inst)
  return s.kind === 'mariadb' && inst.name === 'mysql' ? [] : [...inst.ddl.keys()].sort()
}

/** Filas de una tabla (para los volcados). */
export function rowsOf(s: DbServer, inst: DbInstance, t: string): { columns: string[]; rows: unknown[][] } {
  const db = materialize(s, inst)
  if (!db) return { columns: [], rows: [] }
  try {
    const r = db.exec(`SELECT * FROM ${t}`)[0]
    if (r) return { columns: r.columns, rows: r.values }
    const info = db.exec(`PRAGMA table_info(${t})`)[0]?.values ?? []
    return { columns: info.map((x) => String(x[1])), rows: [] }
  } catch {
    return { columns: [], rows: [] }
  }
}
