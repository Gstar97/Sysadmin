/**
 * Clientes de MariaDB: mysql/mariadb, mysqldump/mariadb-dump, mysqlbinlog/mariadb-binlog y
 * mysqladmin/mariadb-admin, sobre el motor de db/engine.ts.
 */
import { cell, listensOn, mysqlBatch, mysqlInteractive, mysqlTable, mysqlVertical, resolveTarget } from '../db/client'
import { ensureLoaded, parseClientCnf, readClientCnf } from '../db/config'
import { dbServer, execute, hasPriv, matchUser, materialize, mysqlDdl, rowsOf, splitSql, tablesOf, unterminated, versionOf, type BinlogEvent, type DbServer, type Session } from '../db/engine'
import { loadSql } from '../db/sqlite'
import { register, type CommandContext, type Foreground, type IO } from '../shell'
import type { System } from '../system'

interface MyOpts {
  user?: string
  password?: string
  /** -p sin valor: hay que pedirla. */
  ask: boolean
  host?: string
  port?: number
  db?: string
  execute?: string
  batch: boolean
  skipNames: boolean
  table: boolean
  vertical: boolean
  force: boolean
  rest: string[]
  flags: Set<string>
  vals: Map<string, string>
}

function parseMy(args: string[]): MyOpts {
  const o: MyOpts = { ask: false, batch: false, skipNames: false, table: false, vertical: false, force: false, rest: [], flags: new Set(), vals: new Map() }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const take = () => args[++i] ?? ''
    let m: RegExpExecArray | null
    if (a === '-u' || a === '--user') o.user = take()
    else if ((m = /^-u(.+)$/.exec(a)) || (m = /^--user=(.*)$/.exec(a))) o.user = m[1]
    else if (a === '-p' || a === '--password') o.ask = true
    else if ((m = /^-p(.+)$/.exec(a)) || (m = /^--password=(.*)$/.exec(a))) o.password = m[1]
    else if (a === '-h' || a === '--host') o.host = take()
    else if ((m = /^-h(.+)$/.exec(a)) || (m = /^--host=(.*)$/.exec(a))) o.host = m[1]
    else if (a === '-P' || a === '--port') o.port = Number(take())
    else if ((m = /^--port=(\d+)$/.exec(a))) o.port = Number(m[1])
    else if (a === '-D' || a === '--database') o.db = take()
    else if ((m = /^--database=(.*)$/.exec(a))) o.db = m[1]
    else if (a === '-e' || a === '--execute') o.execute = take()
    else if ((m = /^--execute=(.*)$/s.exec(a))) o.execute = m[1]
    else if (a === '-N' || a === '--skip-column-names') o.skipNames = true
    else if (a === '-B' || a === '--batch' || a === '-s' || a === '--silent') o.batch = true
    else if (a === '-t' || a === '--table') o.table = true
    else if (a === '-E' || a === '--vertical') o.vertical = true
    else if (a === '-f' || a === '--force') o.force = true
    else if ((m = /^(--[\w-]+)=(.*)$/s.exec(a))) o.vals.set(m[1], m[2])
    else if (/^-r$|^--result-file$/.test(a)) o.vals.set('--result-file', take())
    else if (a.startsWith('-')) o.flags.add(a)
    else o.rest.push(a)
  }
  return o
}

function socketPath(sys: System): string {
  return sys.distro === 'rocky' ? '/var/lib/mysql/mysql.sock' : '/run/mysqld/mysqld.sock'
}

/** Conecta al servidor MariaDB: devuelve la sesión o el mensaje de error del cliente. */
export function connectMy(ctx: CommandContext, o: MyOpts): Session | string {
  const home = ctx.sys.users.get(ctx.sh.user)?.home ?? `/home/${ctx.sh.user}`
  const only = o.vals.get('--defaults-file')
  const extra = o.vals.get('--defaults-extra-file')
  let cnf = only ? new Map<string, string>() : readClientCnf(ctx.sys, home)
  for (const f of [only, extra].filter((x): x is string => !!x)) {
    let text: string
    try {
      text = ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred)
    } catch {
      return `${ctx.name}: [ERROR] Could not open required defaults file: ${ctx.sh.resolve(f)}\n${ctx.name}: [ERROR] Fatal error in defaults handling. Program aborted`
    }
    cnf = new Map([...cnf, ...parseClientCnf(text)])
  }
  const host = o.host ?? cnf.get('host')
  const port = o.port ?? Number(cnf.get('port') ?? 3306)
  const t = resolveTarget(ctx.sys, host, port)
  if ('error' in t) {
    if (t.error === 'resolve') return `ERROR 2005 (HY000): Unknown server host '${t.host}' (-2)`
    return `ERROR 2002 (HY000): Can't connect to server on '${t.host}' (${t.error === 'timeout' ? 110 : 113})`
  }
  const svc = t.sys.services.get('mariadb')
  if (!svc?.active) return t.tcp ? `ERROR 2002 (HY000): Can't connect to server on '${t.host}' (115)` : `ERROR 2002 (HY000): Can't connect to local server through socket '${socketPath(ctx.sys)}' (2)`
  const s = ensureLoaded(t.sys, 'mariadb')
  if (t.tcp && t.from !== 'localhost') {
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(t.host) ? t.host : ctx.sys.resolveHost(t.host) ?? ''
    if (!listensOn(s.loaded?.bind || '0.0.0.0', ip, false)) return `ERROR 2002 (HY000): Can't connect to server on '${t.host}' (115)`
  }
  const name = o.user ?? cnf.get('user') ?? ctx.sh.user
  const password = o.password ?? cnf.get('password')
  const using = password ? 'YES' : 'NO'
  const u = matchUser(s, name, t.from)
  if (!u) {
    if (t.from !== 'localhost' && !s.users.some((x) => x.host !== 'localhost' && hostOk(x.host, t.from))) return `ERROR 1130 (HY000): Host '${t.from}' is not allowed to connect to this MariaDB server`
    return `ERROR 1045 (28000): Access denied for user '${name}'@'${t.from}' (using password: ${using})`
  }
  if (u.plugin === 'unix_socket') {
    if (t.tcp || ctx.sh.user !== u.name) return t.tcp ? `ERROR 1045 (28000): Access denied for user '${name}'@'${t.from}' (using password: ${using})` : `ERROR 1698 (28000): Access denied for user '${name}'@'localhost'`
  } else if ((u.password ?? '') !== (password ?? '')) {
    return `ERROR 1045 (28000): Access denied for user '${name}'@'${t.from}' (using password: ${using})`
  }
  const sess: Session = { server: s, user: u, from: t.from }
  const db = o.db ?? o.rest[0] ?? cnf.get('database')
  if (db) {
    const r = execute(sess, `USE \`${db}\``)
    if (r.kind === 'error') return r.text
  }
  s.thread++
  return sess
}

function hostOk(pattern: string, from: string): boolean {
  if (pattern === '%') return true
  return new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(from)
}

/** Ejecuta un texto con varias sentencias, como mysql < archivo o mysql -e. */
function runScript(ctx: { out: (s: string) => void; err: (s: string) => void }, sess: Session, text: string, o: MyOpts, tty: boolean, fromE: boolean): number {
  const stmts = splitSql(text, 'mariadb')
  let code = 0
  for (const st of stmts) {
    const vertical = /\\G\s*$/.test(st) || o.vertical
    const r = execute(sess, st.replace(/\\G\s*$/, ''))
    if (r.kind === 'error') {
      const line = fromE ? 1 : lineOf(text, st)
      ctx.err(r.text.replace(/^(ERROR \d+ \(\w+\))/, `$1 at line ${line}`) + '\n')
      code = 1
      if (!o.force) return code
      continue
    }
    if (r.kind !== 'rows' || !r.columns.length) continue
    if (vertical) ctx.out(mysqlVertical(r.columns, r.rows))
    else if ((tty && fromE && !o.batch) || o.table) ctx.out(r.rows.length || o.table ? mysqlTable(r.columns, r.rows) : '')
    else ctx.out(mysqlBatch(r.columns, r.rows, !o.skipNames))
  }
  return code
}

function lineOf(text: string, stmt: string): number {
  const i = text.indexOf(stmt.slice(0, 30))
  return i < 0 ? 1 : text.slice(0, i).split('\n').length
}

const BANNER = (sess: Session) =>
  `Welcome to the MariaDB monitor.  Commands end with ; or \\g.\nYour MariaDB connection id is ${sess.server.thread}\nServer version: ${versionOf(sess.server.sys, 'mariadb')} ${sess.server.sys.distro === 'rocky' ? 'MariaDB Server' : 'Ubuntu 26.04'}\n\nCopyright (c) 2000, 2018, Oracle, MariaDB Corporation Ab and others.\n\nType 'help;' or '\\h' for help. Type '\\c' to clear the current input statement.\n\n`

const HELP = `General information about MariaDB can be found at
http://mariadb.org

List of all client commands:
Note that all text commands must be first on line and end with ';'
?         (\\?) Synonym for \`help'.
clear     (\\c) Clear the current input statement.
connect   (\\r) Reconnect to the server. Optional arguments are db and host.
ego       (\\G) Send command to MariaDB server, display result vertically.
exit      (\\q) Exit mysql. Same as quit.
go        (\\g) Send command to MariaDB server.
help      (\\h) Display this help.
quit      (\\q) Quit mysql.
source    (\\.) Execute an SQL script file. Takes a file name as an argument.
status    (\\s) Get status information from the server.
use       (\\u) Use another database. Takes database name as argument.

`

/** El cliente interactivo: prompt MariaDB [base]> y sentencias que terminan en ; o \G. */
class MysqlRepl implements Foreground {
  buf: string[] = []
  constructor(
    private sess: Session,
    private ctx: CommandContext,
  ) {}

  prompt(): string {
    if (!this.buf.length) return `MariaDB [${this.sess.db ?? '(none)'}]> `
    const text = this.buf.join('\n')
    const q = openQuote(text)
    return q ? `    ${q}> ` : '    -> '
  }

  async line(text: string, io: IO): Promise<'exit' | void> {
    await loadSql()
    const t = text.trim()
    if (!this.buf.length) {
      if (/^(exit|quit|\\q)\s*;?$/i.test(t)) {
        io.out('Bye\n')
        return 'exit'
      }
      if (/^(help|\\h|\\\?|\?)\s*;?$/i.test(t)) {
        io.out(HELP)
        return
      }
      if (/^(status|\\s)\s*;?$/i.test(t)) {
        const s = this.sess.server
        io.out(`--------------\nmariadb from ${versionOf(s.sys, 'mariadb').split('-')[0]}-MariaDB, client 15.2 for Linux (x86_64)\n\nConnection id:\t\t${s.thread}\nCurrent database:\t${this.sess.db ?? ''}\nCurrent user:\t\t${this.sess.user.name}@${this.sess.from}\nServer:\t\t\tMariaDB\nServer version:\t\t${versionOf(s.sys, 'mariadb')}\nConnection:\t\t${this.sess.from === 'localhost' ? `Localhost via UNIX socket` : `${this.sess.from} via TCP/IP`}\nUNIX socket:\t\t${socketPath(s.sys)}\nUptime:\t\t\t1 day 2 hours 3 min 12 sec\n--------------\n\n`)
        return
      }
      const use = /^(?:use|\\u)\s+`?(\w+)`?\s*;?$/i.exec(t)
      if (use) {
        io.out(mysqlInteractive(execute(this.sess, `USE \`${use[1]}\``), false))
        return
      }
      const src = /^(?:source|\\\.)\s+(\S+)\s*;?$/i.exec(t)
      if (src) {
        let content: string
        try {
          content = this.ctx.sys.vfs.readFile(this.ctx.sh.resolve(src[1]), this.ctx.sh.cred)
        } catch {
          io.out(`ERROR: Failed to open file '${src[1]}', error: 2\n`)
          return
        }
        for (const st of splitSql(content, 'mariadb')) io.out(mysqlInteractive(execute(this.sess, st), false))
        return
      }
      if (!t) return
    }
    if (/\\c\s*$/.test(t)) {
      this.buf = []
      return
    }
    this.buf.push(text)
    const all = this.buf.join('\n')
    if (unterminated(all, 'mariadb')) return
    this.buf = []
    const stmts = splitSql(all.replace(/\\G\s*$/, ';__VERTICAL__'), 'mariadb')
    for (let i = 0; i < stmts.length; i++) {
      if (stmts[i] === '__VERTICAL__') continue
      const vertical = stmts[i + 1] === '__VERTICAL__'
      io.out(mysqlInteractive(execute(this.sess, stmts[i]), vertical))
    }
  }
}

function openQuote(text: string): string {
  let q = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '\\') i++
      else if (c === q) q = ''
    } else if (c === "'" || c === '"' || c === '`') q = c
  }
  return q
}

/** Pedido de contraseña (Enter password:) antes de conectarse. */
class PasswordPrompt implements Foreground {
  secret = true
  constructor(
    private label: string,
    private onPassword: (pw: string, io: IO) => Promise<'exit' | void>,
  ) {}
  prompt() {
    return this.label
  }
  line(text: string, io: IO) {
    return this.onPassword(text, io)
  }
}

async function mysqlMain(ctx: CommandContext): Promise<number> {
  const o = parseMy(ctx.args)
  if (o.flags.has('--version') || o.flags.has('-V')) {
    ctx.out(`${ctx.name} from ${versionOf(ctx.sys, 'mariadb').split('-')[0]}-MariaDB, client 15.2 for Linux (x86_64) using  EditLine wrapper\n`)
    return 0
  }
  await loadSql()
  const stdinText = ctx.stdin.readAll()
  const go = (pw: string | undefined, io: { out: (s: string) => void; err: (s: string) => void }): number | 'repl' => {
    const sess = connectMy(ctx, { ...o, password: pw ?? o.password })
    if (typeof sess === 'string') {
      io.err(sess + '\n')
      return 1
    }
    if (o.execute !== undefined) return runScript(io, sess, o.execute, o, ctx.isTTY, true)
    if (stdinText) return runScript(io, sess, stdinText, o, false, false)
    if (!ctx.isTTY) return 0
    io.out(BANNER(sess))
    ctx.sh.fg = new MysqlRepl(sess, ctx)
    return 'repl'
  }
  if (o.ask) {
    if (!ctx.isTTY || stdinText) {
      ctx.err('[simulador] Con la entrada redirigida, la contraseña no se puede escribir: usá -pLaClave (sin espacio) o un archivo ~/.my.cnf.\n')
      return 1
    }
    ctx.sh.fg = new PasswordPrompt('Enter password: ', async (pw, io) => {
      ctx.sh.fg = undefined
      const r = go(pw, io)
      if (r === 'repl') return
      ctx.sh.lastExit = r
      return 'exit'
    })
    return 0
  }
  const r = go(undefined, ctx)
  return r === 'repl' ? 0 : r
}

register(['mysql', 'mariadb'], { usage: 'mysql [-u usuario] [-p] [-h servidor] [-e "SQL"] [base]', run: mysqlMain })

// ---------------------------------------------------------------------------------------
// mysqldump
// ---------------------------------------------------------------------------------------

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

export function dumpDatabase(s: DbServer, name: string, opts: { withCreateDb: boolean; noData: boolean; tables?: string[] }): string {
  const inst = s.dbs.get(name)!
  let out = ''
  if (opts.withCreateDb) out += `--\n-- Current Database: \`${name}\`\n--\n\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ \`${name}\` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci */;\n\nUSE \`${name}\`;\n\n`
  for (const t of tablesOf(s, inst).filter((x) => !opts.tables?.length || opts.tables.includes(x))) {
    out += `--\n-- Table structure for table \`${t}\`\n--\n\nDROP TABLE IF EXISTS \`${t}\`;\n/*!40101 SET @saved_cs_client     = @@character_set_client */;\n/*!40101 SET character_set_client = utf8mb4 */;\n${mysqlDdl(inst.ddl.get(t)!)};\n/*!40101 SET character_set_client = @saved_cs_client */;\n\n`
    if (opts.noData) continue
    const { rows } = rowsOf(s, inst, t)
    out += `--\n-- Dumping data for table \`${t}\`\n--\n\nLOCK TABLES \`${t}\` WRITE;\n/*!40000 ALTER TABLE \`${t}\` DISABLE KEYS */;\n`
    if (rows.length) out += `INSERT INTO \`${t}\` VALUES ${rows.map((r) => `(${r.map(sqlValue).join(',')})`).join(',')};\n`
    out += `/*!40000 ALTER TABLE \`${t}\` ENABLE KEYS */;\nUNLOCK TABLES;\n\n`
  }
  for (const [k, v] of inst.indexes) if (!opts.tables?.length || opts.tables.includes(v.table)) out += `CREATE ${v.unique ? 'UNIQUE ' : ''}INDEX \`${k}\` ON \`${v.table}\` (${v.columns.map((c) => `\`${c}\``).join(',')});\n`
  return out
}

export function dumpHeader(s: DbServer, host: string, db: string): string {
  return `/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump 10.19-${versionOf(s.sys, 'mariadb').split('-')[0]}-MariaDB, for Linux (x86_64)\n--\n-- Host: ${host}    Database: ${db}\n-- ------------------------------------------------------\n-- Server version\t${versionOf(s.sys, 'mariadb')}\n\n/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n/*!40101 SET NAMES utf8mb4 */;\n/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n/*!40103 SET TIME_ZONE='+00:00' */;\n/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n\n`
}

export function dumpFooter(at = Date.now()): string {
  return `/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n\n-- Dump completed on ${fmtDate(at)}\n`
}

export function fmtDate(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function mysqldumpMain(ctx: CommandContext): Promise<number> {
  const o = parseMy(ctx.args)
  await loadSql()
  if (o.ask) {
    ctx.err('[simulador] mysqldump no puede pedir la contraseña en el simulador: usá -pLaClave o ~/.my.cnf.\n')
    return 1
  }
  const sess = connectMy(ctx, { ...o, rest: [] })
  if (typeof sess === 'string') {
    const m = /^ERROR (\d+) \(\w+\): (.*)$/.exec(sess)
    ctx.err(m ? `${ctx.name}: Got error: ${m[1]}: "${m[2]}" when trying to connect\n` : sess + '\n')
    return 2
  }
  const s = sess.server
  const all = o.flags.has('--all-databases') || o.flags.has('-A')
  const multi = o.flags.has('--databases') || o.flags.has('-B') || all
  const noData = o.flags.has('--no-data') || o.flags.has('-d')
  const names = all ? [...s.dbs.keys()].filter((d) => d !== 'mysql') : multi ? o.rest : o.rest.slice(0, 1)
  if (!names.length) {
    ctx.err(`Usage: ${ctx.name} [OPTIONS] database [tables]\nOR     ${ctx.name} [OPTIONS] --databases DB1 [DB2 DB3...]\nOR     ${ctx.name} [OPTIONS] --all-databases\nFor more options, use ${ctx.name} --help\n`)
    return 1
  }
  for (const n of names) {
    if (!s.dbs.has(n)) {
      ctx.err(`${ctx.name}: Got error: 1049: "Unknown database '${n}'" when selecting the database\n`)
      return 2
    }
    if (!hasPriv(sess, 'SELECT', n)) {
      const t = tablesOf(s, s.dbs.get(n)!)[0] ?? ''
      ctx.err(`${ctx.name}: Couldn't execute 'show create table \`${t}\`': SELECT command denied to user '${sess.user.name}'@'${sess.user.host}' for table \`${n}\`.\`${t}\` (1142)\n`)
      return 2
    }
  }
  const sourceData = o.vals.get('--source-data') ?? o.vals.get('--master-data') ?? (o.flags.has('--source-data') || o.flags.has('--master-data') ? '1' : undefined)
  if (sourceData !== undefined && !s.loaded?.logBin) {
    ctx.err(`${ctx.name}: Error: Binlogging on server not active\n`)
    return 2
  }
  if (o.flags.has('--flush-logs') || o.flags.has('-F')) execute({ ...sess, user: { ...sess.user, superuser: true } }, 'FLUSH LOGS')
  let out = dumpHeader(s, sess.from, multi ? names.join(' ') : names[0])
  if (sourceData !== undefined) {
    const f = s.binlog.at(-1)
    out += `--\n-- Position to start replication or point-in-time recovery from\n--\n\n${sourceData === '2' ? '-- ' : ''}CHANGE MASTER TO MASTER_LOG_FILE='${f?.name ?? ''}', MASTER_LOG_POS=${f?.size ?? 4};\n\n`
  }
  for (const n of names) out += dumpDatabase(s, n, { withCreateDb: multi, noData, tables: multi ? undefined : o.rest.slice(1) })
  out += dumpFooter()
  const file = o.vals.get('--result-file')
  if (file) {
    try {
      ctx.sys.vfs.writeFile(ctx.sh.resolve(file), out, ctx.sh.cred, { umask: ctx.sh.umask })
    } catch {
      ctx.err(`${ctx.name}: Can't create/write to file '${file}' (Errcode: 13 "Permission denied")\n`)
      return 2
    }
    return 0
  }
  ctx.out(out)
  return 0
}

register(['mysqldump', 'mariadb-dump'], { usage: 'mysqldump [opciones] base [tablas] | --databases b1 b2 | --all-databases', run: mysqldumpMain })

// ---------------------------------------------------------------------------------------
// mysqlbinlog
// ---------------------------------------------------------------------------------------

function ts(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())} ${String(d.getHours()).padStart(2, ' ')}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function parseDateTime(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim())
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime()
}

async function mysqlbinlogMain(ctx: CommandContext): Promise<number> {
  const o = parseMy(ctx.args)
  const files = o.rest
  if (!files.length) {
    ctx.err(`Usage: ${ctx.name} [options] log-files\n`)
    return 1
  }
  const s = dbServer(ctx.sys, 'mariadb')
  const startPos = Number(o.vals.get('--start-position') ?? 0)
  const stopPos = o.vals.has('--stop-position') ? Number(o.vals.get('--stop-position')) : Infinity
  const startDt = o.vals.has('--start-datetime') ? parseDateTime(o.vals.get('--start-datetime')!) : undefined
  const stopDt = o.vals.has('--stop-datetime') ? parseDateTime(o.vals.get('--stop-datetime')!) : undefined
  if ((o.vals.has('--start-datetime') && startDt === undefined) || (o.vals.has('--stop-datetime') && stopDt === undefined)) {
    ctx.err(`${ctx.name}: Incorrect date and time argument: ${o.vals.get('--start-datetime') ?? o.vals.get('--stop-datetime')}\n`)
    return 1
  }
  const dbFilter = o.vals.get('--database') ?? o.db
  let out = `/*!50530 SET @@SESSION.PSEUDO_SLAVE_MODE=1*/;\n/*!40019 SET @@session.max_delayed_threads=0*/;\n/*!50003 SET @OLD_COMPLETION_TYPE=@@COMPLETION_TYPE,COMPLETION_TYPE=0*/;\nDELIMITER /*!*/;\n`
  for (const f of files) {
    const path = ctx.sh.resolve(f)
    try {
      ctx.sys.vfs.readFile(path, ctx.sh.cred)
    } catch (e) {
      const denied = String(e).includes('EACCES')
      ctx.err(`ERROR: Could not open log file\n${ctx.name}: File '${f}' not found (Errcode: ${denied ? 13 : 2} "${denied ? 'Permission denied' : 'No such file or directory'}")\n`)
      return 1
    }
    const bf = s.binlog.find((b) => b.name === path.split('/').pop())
    if (!bf) {
      ctx.err(`ERROR: File is not a binary log file.\n`)
      return 1
    }
    const first = bf.events[0]?.time ?? Date.now()
    out += `# at 4\n#${ts(first)} server id ${s.loaded?.serverId ?? 1}  end_log_pos 256 CRC32 0x1b2e9c4d \tStart: binlog v 4, server v ${versionOf(ctx.sys, 'mariadb')}-log created ${ts(first)}\n`
    const pick = (e: BinlogEvent) => e.pos >= startPos && e.pos < stopPos && (startDt === undefined || e.time >= startDt) && (stopDt === undefined || e.time < stopDt) && (!dbFilter || e.db === dbFilter)
    let lastDb = ''
    for (const e of bf.events.filter(pick)) {
      out += `# at ${e.pos}\n#${ts(e.time)} server id ${s.loaded?.serverId ?? 1}  end_log_pos ${e.end} CRC32 0x${(e.pos * 2654435761 >>> 0).toString(16).padStart(8, '0')} \tQuery\tthread_id=${e.thread}\texec_time=0\terror_code=0\n`
      if (e.db && e.db !== lastDb) {
        out += `use \`${e.db}\`/*!*/;\n`
        lastDb = e.db
      }
      out += `SET TIMESTAMP=${Math.floor(e.time / 1000)}/*!*/;\n${e.sql}\n/*!*/;\n`
    }
    out += `# at ${bf.size}\n#${ts(bf.events.at(-1)?.time ?? first)} server id ${s.loaded?.serverId ?? 1}  end_log_pos ${bf.size + 23} CRC32 0x00000000 \tRotate to ${bf.name.replace(/\d+$/, (n) => String(Number(n) + 1).padStart(6, '0'))}  pos: 4\n`
  }
  out += `DELIMITER ;\n# End of log file\nROLLBACK /* added by mysqlbinlog */;\n/*!50003 SET COMPLETION_TYPE=@OLD_COMPLETION_TYPE*/;\n/*!50530 SET @@SESSION.PSEUDO_SLAVE_MODE=0*/;\n`
  ctx.out(out)
  return 0
}

register(['mysqlbinlog', 'mariadb-binlog'], { usage: 'mysqlbinlog [--start-position=N] [--stop-datetime="AAAA-MM-DD HH:MM:SS"] archivos', run: mysqlbinlogMain })

// ---------------------------------------------------------------------------------------
// mysqladmin y secure-installation
// ---------------------------------------------------------------------------------------

register(['mysqladmin', 'mariadb-admin'], {
  usage: 'mysqladmin [-u usuario] [-p] ping | status | version | processlist | flush-logs',
  async run(ctx) {
    const o = parseMy(ctx.args)
    await loadSql()
    const sess = connectMy(ctx, o)
    if (typeof sess === 'string') {
      const svcDown = /2002/.test(sess)
      ctx.err(svcDown ? `${ctx.name}: connect to server at 'localhost' failed\nerror: 'Can't connect to local server through socket '${socketPath(ctx.sys)}' (2)'\nCheck that mariadbd is running and that the socket: '${socketPath(ctx.sys)}' exists!\n` : `${ctx.name}: connect to server at 'localhost' failed\nerror: '${sess.replace(/^ERROR \d+ \(\w+\): /, '')}'\n`)
      return 1
    }
    const cmd = o.rest[0] ?? ''
    if (cmd === 'ping') ctx.out('mysqld is alive\n')
    else if (cmd === 'status') ctx.out(`Uptime: 93812  Threads: 3  Questions: 182934  Slow queries: 12  Opens: 77  Open tables: 70  Queries per second avg: 1.950\n`)
    else if (cmd === 'version') ctx.out(`${ctx.name}  Ver 10.0 Distrib ${versionOf(ctx.sys, 'mariadb')}, for Linux on x86_64\n\nServer version\t\t${versionOf(ctx.sys, 'mariadb')}\nProtocol version\t10\nConnection\t\tLocalhost via UNIX socket\nUNIX socket\t\t${socketPath(ctx.sys)}\nUptime:\t\t\t1 day 2 hours 3 min 32 sec\n`)
    else if (cmd === 'processlist') ctx.out(mysqlTable(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info', 'Progress'], [[sess.server.thread, sess.user.name, 'localhost', null, 'Query', 0, 'starting', 'show processlist', 0]]))
    else if (cmd === 'flush-logs') {
      const r = execute(sess, 'FLUSH LOGS')
      if (r.kind === 'error') {
        ctx.err(`${ctx.name}: refresh failed; error: '${r.text.replace(/^ERROR \d+ \(\w+\): /, '')}'\n`)
        return 1
      }
    } else {
      ctx.err(`${ctx.name}: Unknown command: '${cmd}'\n`)
      return 1
    }
    return 0
  },
})

register(['mysql_secure_installation', 'mariadb-secure-installation'], {
  usage: 'mariadb-secure-installation',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('[simulador] Ejecutalo con sudo.\n')
      return 1
    }
    ctx.out(`\nNOTE: RUNNING ALL PARTS OF THIS SCRIPT IS RECOMMENDED FOR ALL MariaDB\n      SERVERS IN PRODUCTION USE!  PLEASE READ EACH STEP CAREFULLY!\n\n[simulador] Este asistente es interactivo y en el simulador no se puede contestar. En tu laboratorio, las respuestas recomendadas son:\n  - Switch to unix_socket authentication: Y (root entra solo con sudo, sin contraseña)\n  - Change the root password: n (con unix_socket no hace falta)\n  - Remove anonymous users: Y\n  - Disallow root login remotely: Y\n  - Remove test database and access to it: Y\n  - Reload privilege tables now: Y\nEn esta instalación simulada ya está todo así: root entra solo por el socket y no hay usuarios anónimos ni base test.\n\nThanks for using MariaDB!\n`)
    return 0
  },
})

/** Para las verificaciones: el valor de la primera celda de una consulta. */
export function firstCell(sys: System, kind: 'mariadb', db: string, sql: string): string | undefined {
  const s = dbServer(sys, kind)
  const inst = s.dbs.get(db)
  if (!inst || !materialize(s, inst)) return undefined
  const root = s.users.find((u) => u.superuser)!
  const r = execute({ server: s, user: root, db, from: 'localhost', noLog: true }, sql)
  if (r.kind !== 'rows') return undefined
  return r.rows[0] ? cell(r.rows[0][0], 'mariadb') : ''
}

