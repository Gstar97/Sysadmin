/**
 * Clientes de PostgreSQL: psql, pg_dump, pg_dumpall, pg_restore, createdb, dropdb, createuser,
 * pg_isready, postgresql-setup (Rocky) y pg_lsclusters (Ubuntu).
 */
import { cell, listensOn, psqlTable, resolveTarget } from '../db/client'
import { ensureLoaded } from '../db/config'
import { dbServer, execute, findUser, materialize, pgConfDir, pgDataDir, pgMajor, rowsOf, splitSql, tablesOf, unterminated, versionOf, type DbServer, type HbaRule, type Result, type Session } from '../db/engine'
import { loadSql } from '../db/sqlite'
import { register, type CommandContext, type Foreground, type IO } from '../shell'
import type { System } from '../system'
import { ROOT_CRED } from '../vfs'

interface PgOpts {
  user?: string
  db?: string
  host?: string
  port?: number
  command: string[]
  file?: string
  tuplesOnly: boolean
  unaligned: boolean
  expanded: boolean
  quiet: boolean
  stopOnError: boolean
  noPassword: boolean
  forcePassword: boolean
  list: boolean
  rest: string[]
  flags: Set<string>
  vals: Map<string, string>
}

function parsePg(args: string[]): PgOpts {
  const o: PgOpts = { command: [], tuplesOnly: false, unaligned: false, expanded: false, quiet: false, stopOnError: false, noPassword: false, forcePassword: false, list: false, rest: [], flags: new Set(), vals: new Map() }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const take = () => args[++i] ?? ''
    let m: RegExpExecArray | null
    if (a === '-U' || a === '--username') o.user = take()
    else if ((m = /^--username=(.*)$/.exec(a)) || (m = /^-U(.+)$/.exec(a))) o.user = m[1]
    else if (a === '-d' || a === '--dbname') o.db = take()
    else if ((m = /^--dbname=(.*)$/.exec(a))) o.db = m[1]
    else if (a === '-h' || a === '--host') o.host = take()
    else if ((m = /^--host=(.*)$/.exec(a))) o.host = m[1]
    else if (a === '-p' || a === '--port') o.port = Number(take())
    else if ((m = /^--port=(\d+)$/.exec(a))) o.port = Number(m[1])
    else if (a === '-c' || a === '--command') o.command.push(take())
    else if ((m = /^--command=(.*)$/s.exec(a))) o.command.push(m[1])
    else if (a === '-f' || a === '--file') o.file = take()
    else if ((m = /^--file=(.*)$/.exec(a))) o.file = m[1]
    else if (a === '-t' || a === '--tuples-only') o.tuplesOnly = true
    else if (a === '-A' || a === '--no-align') o.unaligned = true
    else if (a === '-x' || a === '--expanded') o.expanded = true
    else if (a === '-q' || a === '--quiet') o.quiet = true
    else if (a === '-w' || a === '--no-password') o.noPassword = true
    else if (a === '-W' || a === '--password') o.forcePassword = true
    else if (a === '-l' || a === '--list') o.list = true
    else if (a === '-v' || a === '--set') {
      const v = take()
      if (/^ON_ERROR_STOP=(1|on|true)$/i.test(v)) o.stopOnError = true
    } else if (/^--set=ON_ERROR_STOP=(1|on)$/i.test(a)) o.stopOnError = true
    else if (a === '-F') o.vals.set('--format', take())
    else if ((m = /^-F(\w)$/.exec(a))) o.vals.set('--format', m[1])
    else if (a === '-t' || a === '--table') o.vals.set('--table', take())
    else if (/^-[tAqxXwW]{2,}$/.test(a)) {
      // Opciones cortas juntas, como -tAqX (las que usan los scripts y los módulos de Ansible).
      for (const f of a.slice(1)) {
        if (f === 't') o.tuplesOnly = true
        else if (f === 'A') o.unaligned = true
        else if (f === 'q') o.quiet = true
        else if (f === 'x') o.expanded = true
        else if (f === 'w') o.noPassword = true
        else if (f === 'W') o.forcePassword = true
      }
    } else if ((m = /^(--[\w-]+)=(.*)$/s.exec(a))) o.vals.set(m[1], m[2])
    else if (a.startsWith('-')) o.flags.add(a)
    else o.rest.push(a)
  }
  return o
}

const SOCKET = '/run/postgresql/.s.PGSQL.5432'

function hbaMatch(rules: HbaRule[], local: boolean, ip: string, db: string, user: string): HbaRule | undefined {
  return rules.find((r) => {
    if (local !== (r.type === 'local')) return false
    if (r.db !== 'all' && !r.db.split(',').some((d) => d === db || (d === 'sameuser' && db === user))) return false
    if (r.db === 'replication') return false
    if (r.user !== 'all' && !r.user.split(',').includes(user)) return false
    if (!local) return addrMatch(r.address ?? '', ip)
    return true
  })
}

function addrMatch(addr: string, ip: string): boolean {
  if (addr === 'all' || addr === '0.0.0.0/0') return true
  if (addr === 'samehost') return ip.startsWith('127.')
  const [net, bitsS] = addr.split('/')
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(net) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
  const n = (x: string) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
  const bits = Number(bitsS ?? 32)
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n(net) & mask) >>> 0) === ((n(ip) & mask) >>> 0)
}

function readPgpass(ctx: CommandContext, host: string, port: number, db: string, user: string): { pw?: string; warn?: string } {
  const home = ctx.sys.users.get(ctx.sh.user)?.home ?? `/home/${ctx.sh.user}`
  const path = `${home}/.pgpass`
  try {
    const node = ctx.sys.vfs.stat(path, ROOT_CRED)
    const text = ctx.sys.vfs.readFile(path, ctx.sh.cred)
    if ((node.mode & 0o077) !== 0) return { warn: `WARNING: password file "${path}" has group or world access; permissions should be u=rw (0600) or less\n` }
    for (const line of text.split('\n')) {
      const p = line.split(':')
      if (p.length < 5) continue
      const ok = (a: string, b: string) => a === '*' || a === b
      if (ok(p[0], host) && ok(p[1], String(port)) && ok(p[2], db) && ok(p[3], user)) return { pw: p.slice(4).join(':') }
    }
  } catch {
    // sin ~/.pgpass
  }
  return {}
}

type PgConn = { sess: Session; where: string } | { error: string } | { needPassword: (pw: string) => { sess: Session; where: string } | { error: string }; prompt: string }

/** Conecta a PostgreSQL siguiendo pg_hba.conf. */
function connectPg(ctx: CommandContext, o: PgOpts, defaultDb?: string): PgConn {
  const env = (k: string) => ctx.sh.getVar(k)
  const user = o.user ?? env('PGUSER') ?? ctx.sh.user
  const db = o.db ?? o.rest[0] ?? env('PGDATABASE') ?? defaultDb ?? user
  const host = o.host ?? env('PGHOST')
  const port = o.port ?? Number(env('PGPORT') ?? 5432)
  const t = resolveTarget(ctx.sys, host, port)
  const where = 'error' in t || t.tcp ? `at "${host}", port ${port}` : `on socket "${SOCKET}"`
  const fail = (msg: string) => ({ error: `${ctx.name}: error: connection to server ${where} failed: ${msg}` })
  if ('error' in t) {
    if (t.error === 'resolve') return { error: `${ctx.name}: error: could not translate host name "${t.host}" to address: Name or service not known` }
    return fail(t.error === 'timeout' ? 'Connection timed out\n\tIs the server running on that host and accepting TCP/IP connections?' : 'No route to host\n\tIs the server running on that host and accepting TCP/IP connections?')
  }
  const svc = t.sys.services.get('postgresql')
  if (!svc?.active) return fail(t.tcp ? 'Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?' : 'No such file or directory\n\tIs the server running locally and accepting connections on that socket?')
  const s = ensureLoaded(t.sys, 'postgres')
  const ip = t.tcp ? (/^\d+\.\d+\.\d+\.\d+$/.test(t.host) ? t.host : ctx.sys.resolveHost(t.host) ?? '127.0.0.1') : ''
  if (t.tcp && !listensOn(s.loaded?.listen ?? 'localhost', ip, t.from === 'localhost' || ip.startsWith('127.'))) return fail('Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?')
  const clientIp = t.tcp ? (t.from === 'localhost' ? '127.0.0.1' : t.from) : ''
  const rule = hbaMatch(s.loaded?.hba ?? [], !t.tcp, clientIp, db, user)
  if (!rule) return fail(`FATAL:  no pg_hba.conf entry for host "${t.tcp ? clientIp : '[local]'}", user "${user}", database "${db}", no encryption`)
  const role = findUser(s, user)
  const finish = (): { sess: Session; where: string } | { error: string } => {
    if (!role) return fail(`FATAL:  role "${user}" does not exist`)
    if (!role.login) return fail(`FATAL:  role "${user}" is not permitted to log in`)
    if (!s.dbs.has(db)) return fail(`FATAL:  database "${db}" does not exist`)
    s.thread++
    return { sess: { server: s, user: role, db, from: t.tcp ? clientIp : 'localhost' }, where }
  }
  switch (rule.method) {
    case 'trust':
      return finish()
    case 'reject':
      return fail(`FATAL:  pg_hba.conf rejects connection for host "${t.tcp ? clientIp : '[local]'}", user "${user}", database "${db}", no encryption`)
    case 'peer':
      if (ctx.sh.user !== user) return fail(`FATAL:  Peer authentication failed for user "${user}"`)
      return finish()
    case 'ident':
      return fail(`FATAL:  Ident authentication failed for user "${user}"`)
    default: {
      const check = (pw: string) => {
        if (!role || (role.password ?? '\u0000') !== pw) return fail(`FATAL:  password authentication failed for user "${user}"`)
        return finish()
      }
      const env = ctx.sh.getVar('PGPASSWORD')
      if (env !== undefined && !o.forcePassword) return check(env)
      const pass = readPgpass(ctx, t.tcp ? t.host : 'localhost', port, db, user)
      if (pass.warn) ctx.err(pass.warn)
      if (pass.pw !== undefined && !o.forcePassword) return check(pass.pw)
      if (o.noPassword || !ctx.isTTY) return fail('fe_sendauth: no password supplied')
      return { needPassword: check, prompt: `Password for user ${user}: ` }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------------------

function show(r: Result, o: Pick<PgOpts, 'tuplesOnly' | 'unaligned' | 'expanded' | 'quiet'>): { out?: string; err?: string } {
  switch (r.kind) {
    case 'rows':
      return { out: psqlTable(r.columns, r.rows, { tuplesOnly: o.tuplesOnly, unaligned: o.unaligned, expanded: o.expanded }) }
    case 'ok':
      return o.quiet ? {} : { out: (r.tag ?? 'OK') + '\n' }
    case 'msg':
      return { out: r.text + '\n' }
    case 'error':
      return { err: r.text + '\n' }
    case 'empty':
      return {}
  }
}

function listDatabases(s: DbServer): string {
  const rows = [...s.dbs.values()].map((d) => [d.name, d.owner, 'UTF8', 'libc', 'C.UTF-8', 'C.UTF-8', '', '', d.name === 'postgres' ? '' : `=Tc/${d.owner}            +\n${d.owner}=CTc/${d.owner}`.split('\n')[0]])
  rows.push(['template0', 'postgres', 'UTF8', 'libc', 'C.UTF-8', 'C.UTF-8', '', '', '=c/postgres          +'], ['template1', 'postgres', 'UTF8', 'libc', 'C.UTF-8', 'C.UTF-8', '', '', '=c/postgres          +'])
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return '                                                     List of databases\n' + psqlTable(['Name', 'Owner', 'Encoding', 'Locale Provider', 'Collate', 'Ctype', 'Locale', 'ICU Rules', 'Access privileges'], rows)
}

/** Comandos de barra invertida de psql. Devuelve true si la línea era uno. */
function meta(sess: Session, line: string, io: { out: (s: string) => void; err: (s: string) => void }, state: { expanded: boolean; ctx: CommandContext }): 'exit' | boolean {
  const t = line.trim()
  if (!t.startsWith('\\')) return false
  const [cmd, ...args] = t.split(/\s+/)
  const s = sess.server
  const inst = sess.db ? s.dbs.get(sess.db) : undefined
  switch (cmd) {
    case '\\q':
      return 'exit'
    case '\\l':
    case '\\l+':
    case '\\list':
      io.out(listDatabases(s))
      return true
    case '\\c':
    case '\\connect': {
      const db = args[0] ?? sess.db!
      const user = args[1] && args[1] !== '-' ? args[1] : sess.user.name
      if (!s.dbs.has(db)) {
        io.err(`connection to server on socket "${SOCKET}" failed: FATAL:  database "${db}" does not exist\nPrevious connection kept\n`)
        return true
      }
      const u = findUser(s, user)
      if (!u) {
        io.err(`connection to server on socket "${SOCKET}" failed: FATAL:  role "${user}" does not exist\nPrevious connection kept\n`)
        return true
      }
      if (user !== sess.user.name && !sess.user.superuser) {
        io.err(`connection to server on socket "${SOCKET}" failed: FATAL:  Peer authentication failed for user "${user}"\nPrevious connection kept\n`)
        return true
      }
      sess.db = db
      sess.user = u
      io.out(`You are now connected to database "${db}" as user "${u.name}".\n`)
      return true
    }
    case '\\dt':
    case '\\dt+':
    case '\\d':
    case '\\d+': {
      if (!inst) return true
      if (args[0] && (cmd === '\\d' || cmd === '\\d+')) {
        io.out(describePg(s, inst, args[0]) ?? '')
        if (!inst.ddl.has(args[0])) io.err(`Did not find any relation named "${args[0]}".\n`)
        return true
      }
      const tables = tablesOf(s, inst)
      if (!tables.length) {
        io.err('Did not find any relations.\n')
        return true
      }
      io.out('          List of relations\n' + psqlTable(['Schema', 'Name', 'Type', 'Owner'], tables.map((x) => ['public', x, 'table', inst.tableOwner.get(x) ?? inst.owner])))
      return true
    }
    case '\\du':
    case '\\du+':
    case '\\dg': {
      const rows = [...s.users]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => [u.name, [u.superuser ? 'Superuser, Create role, Create DB, Replication, Bypass RLS' : '', !u.superuser && u.createdb ? 'Create DB' : '', !u.login ? 'Cannot login' : ''].filter(Boolean).join(', ')])
      io.out('                             List of roles\n' + psqlTable(['Role name', 'Attributes'], rows).replace(/\n\(\d+ rows?\)\n/, '\n'))
      return true
    }
    case '\\dn':
      io.out('      List of schemas\n' + psqlTable(['Name', 'Owner'], [['public', 'pg_database_owner']]))
      return true
    case '\\conninfo':
      io.out(sess.from === 'localhost' ? `You are connected to database "${sess.db}" as user "${sess.user.name}" via socket in "/run/postgresql" at port "5432".\n` : `You are connected to database "${sess.db}" as user "${sess.user.name}" on host "${s.sys.ownIps()[1] ?? '127.0.0.1'}" at port "5432".\n`)
      return true
    case '\\x':
      state.expanded = args[0] ? args[0] === 'on' : !state.expanded
      io.out(`Expanded display is ${state.expanded ? 'on' : 'off'}.\n`)
      return true
    case '\\timing':
      io.out('Timing is on.\n')
      return true
    case '\\?':
      io.out('General\n  \\q                     quit psql\n\nInformational\n  \\d[S+]  NAME           describe table, view, sequence, or index\n  \\dt[S+] [PATTERN]      list tables\n  \\du[S+] [PATTERN]      list roles\n  \\l[+]   [PATTERN]      list databases\n\nConnection\n  \\c[onnect] {[DBNAME|- USER|- HOST|- PORT|-] | conninfo}\n                         connect to new database\n  \\conninfo              display information about current connection\n\nInput/Output\n  \\i FILE                execute commands from file\n\nFormatting\n  \\x [on|off|auto]       toggle expanded output\n')
      return true
    case '\\i': {
      const f = args[0]
      try {
        const text = state.ctx.sys.vfs.readFile(state.ctx.sh.resolve(f), state.ctx.sh.cred)
        runPsqlScript(sess, text, io, { tuplesOnly: false, unaligned: false, expanded: state.expanded, quiet: false, stopOnError: false }, f)
      } catch {
        io.err(`${f}: No such file or directory\n`)
      }
      return true
    }
    case '\\password':
      io.err('[simulador] \\password pide la clave dos veces sin mostrarla; acá usá ALTER ROLE nombre WITH PASSWORD \'...\';\n')
      return true
    default:
      io.err(`invalid command ${cmd}\nTry \\? for help.\n`)
      return true
  }
}

function describePg(s: DbServer, inst: NonNullable<ReturnType<DbServer['dbs']['get']>>, table: string): string | undefined {
  const db = materialize(s, inst)
  if (!db || !inst.ddl.has(table)) return undefined
  const info = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []
  const ddl = inst.ddl.get(table)!
  const rows = info.map((r) => {
    const name = String(r[1])
    const def = new RegExp('"?' + name + '"?\\s+([^,\\n]+)', 'i').exec(ddl)?.[1] ?? ''
    const serial = /SERIAL/i.test(def)
    let type = String(r[2]).toLowerCase().replace(/^varchar/, 'character varying').replace(/^serial$|^integer$|^int$/, 'integer').replace(/^bigserial$/, 'bigint').replace(/^timestamp$/, 'timestamp without time zone').replace(/^numeric/, 'numeric').replace(/^decimal/, 'numeric')
    if (serial && type === 'integer') type = 'integer'
    return [name, type, '', r[3] || r[5] ? 'not null' : '', serial ? `nextval('${table}_${name}_seq'::regclass)` : r[4] === null ? '' : String(r[4])]
  })
  let out = `                Table "public.${table}"\n` + psqlTable(['Column', 'Type', 'Collation', 'Nullable', 'Default'], rows).replace(/\(\d+ rows?\)\n/, '')
  const idx = [`    "${table}_pkey" PRIMARY KEY, btree (${info.find((r) => r[5])?.[1] ?? 'id'})`, ...[...inst.indexes.entries()].filter(([, v]) => v.table === table).map(([k, v]) => `    "${k}"${v.unique ? ' UNIQUE,' : ''} btree (${v.columns.join(', ')})`)]
  out = out.replace(/\n$/, '') + 'Indexes:\n' + idx.join('\n') + '\n\n'
  return out
}

/** Ejecuta un script de psql (archivo, -c o entrada estándar), con COPY ... FROM stdin y comandos \. */
function runPsqlScript(sess: Session, text: string, io: { out: (s: string) => void; err: (s: string) => void }, o: Pick<PgOpts, 'tuplesOnly' | 'unaligned' | 'expanded' | 'quiet' | 'stopOnError'>, file?: string): number {
  let buf: string[] = []
  let copy: { table: string; cols: string; n: number } | undefined
  let code = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (copy) {
      if (line === '\\.') {
        if (!o.quiet) io.out(`COPY ${copy.n}\n`)
        copy = undefined
        continue
      }
      const vals = line.split('\t').map((v) => (v === '\\N' ? 'NULL' : `'${v.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/'/g, "''")}'`))
      const r = execute(sess, `INSERT INTO ${copy.table} ${copy.cols} VALUES (${vals.join(', ')})`)
      if (r.kind === 'error') {
        io.err(`${file ? `psql:${file}:${i + 1}: ` : ''}${r.text}\n`)
        code = 3
        if (o.stopOnError) return code
      } else copy.n++
      continue
    }
    if (!buf.length && line.trim().startsWith('\\')) {
      const r = meta(sess, line, io, { expanded: o.expanded, ctx: undefined as never })
      if (r === 'exit') return code
      continue
    }
    buf.push(line)
    const all = buf.join('\n')
    if (unterminated(all, 'postgres')) continue
    buf = []
    for (const st of splitSql(all, 'postgres')) {
      const cp = /^COPY\s+([\w."]+)\s*(\([^)]*\))?\s+FROM\s+stdin/i.exec(st)
      if (cp) {
        const table = cp[1].replace(/^public\./, '').replace(/"/g, '')
        if (!sess.db || !sess.server.dbs.get(sess.db)?.ddl.has(table)) {
          io.err(`${file ? `psql:${file}:${i + 1}: ` : ''}ERROR:  relation "${table}" does not exist\n`)
          code = 3
          // se saltean los datos de ese COPY
          while (i + 1 < lines.length && lines[i + 1] !== '\\.') i++
          i++
          continue
        }
        copy = { table, cols: cp[2] ?? '', n: 0 }
        continue
      }
      const r = execute(sess, st)
      const v = show(r, o)
      if (v.out) io.out(v.out)
      if (v.err) {
        io.err(`${file ? `psql:${file}:${i + 1}: ` : ''}${v.err}`)
        code = file ? 3 : 1
        if (o.stopOnError) return code
      }
    }
  }
  return code
}

// ---------------------------------------------------------------------------------------
// psql interactivo
// ---------------------------------------------------------------------------------------

class PsqlRepl implements Foreground {
  buf: string[] = []
  state: { expanded: boolean; ctx: CommandContext }
  constructor(
    private sess: Session,
    ctx: CommandContext,
  ) {
    this.state = { expanded: false, ctx }
  }

  prompt(): string {
    const sym = this.sess.user.superuser ? '#' : '>'
    if (!this.buf.length) return `${this.sess.db}=${sym} `
    const text = this.buf.join('\n')
    let q = ''
    let paren = 0
    for (const c of text) {
      if (q) {
        if (c === q) q = ''
      } else if (c === "'" || c === '"') q = c
      else if (c === '(') paren++
      else if (c === ')') paren--
    }
    return `${this.sess.db}${q ? q : paren > 0 ? '(' : '-'}${sym} `
  }

  async line(text: string, io: IO): Promise<'exit' | void> {
    await loadSql()
    const t = text.trim()
    if (!this.buf.length) {
      if (/^(exit|quit)$/i.test(t)) return 'exit'
      if (/^help$/i.test(t)) {
        io.out(`You are using psql, the command-line interface to PostgreSQL.\nType:  \\copyright for distribution terms\n       \\h for help with SQL commands\n       \\? for help with psql commands\n       \\g or terminate with semicolon to execute query\n       \\q to quit\n`)
        return
      }
      if (t.startsWith('\\')) {
        const r = meta(this.sess, t, io, this.state)
        return r === 'exit' ? 'exit' : undefined
      }
      if (!t) return
    }
    this.buf.push(text)
    const all = this.buf.join('\n')
    if (unterminated(all, 'postgres')) return
    this.buf = []
    runPsqlScript(this.sess, all, io, { tuplesOnly: false, unaligned: false, expanded: this.state.expanded, quiet: false, stopOnError: false })
  }
}

class PasswordPrompt implements Foreground {
  secret = true
  constructor(
    private label: string,
    private onPassword: (pw: string, io: IO) => 'exit' | void,
  ) {}
  prompt() {
    return this.label
  }
  async line(text: string, io: IO) {
    return this.onPassword(text, io)
  }
}

register('psql', {
  usage: 'psql [-U usuario] [-d base] [-h servidor] [-c "SQL"] [-f archivo]',
  async run(ctx) {
    const o = parsePg(ctx.args)
    if (o.flags.has('--version') || o.flags.has('-V')) {
      ctx.out(`psql (PostgreSQL) ${versionOf(ctx.sys, 'postgres').split(' ')[0]}\n`)
      return 0
    }
    await loadSql()
    const stdinText = ctx.stdin.readAll()
    const after = (c: { sess: Session; where: string }, io: { out: (s: string) => void; err: (s: string) => void }): number | 'repl' => {
      if (o.list) {
        io.out(listDatabases(c.sess.server))
        return 0
      }
      if (o.command.length) {
        let code = 0
        for (const cmd of o.command) {
          if (cmd.trim().startsWith('\\')) {
            meta(c.sess, cmd, io, { expanded: o.expanded, ctx })
            continue
          }
          code = Math.max(code, runPsqlScript(c.sess, cmd.trim().endsWith(';') ? cmd : cmd + ';', io, o))
        }
        return code ? 1 : 0
      }
      if (o.file) {
        let text: string
        try {
          text = ctx.sys.vfs.readFile(ctx.sh.resolve(o.file), ctx.sh.cred)
        } catch (e) {
          io.err(`psql: error: ${o.file}: ${String(e).includes('EACCES') ? 'Permission denied' : 'No such file or directory'}\n`)
          return 1
        }
        if (text.startsWith('PGDMP')) {
          io.err('The input is a PostgreSQL custom-format dump.\nUse the pg_restore command-line client to restore this dump to a database.\n')
          return 1
        }
        return runPsqlScript(c.sess, text, io, o, o.file)
      }
      if (stdinText) return runPsqlScript(c.sess, stdinText, io, o)
      if (!ctx.isTTY) return 0
      io.out(`psql (${versionOf(ctx.sys, 'postgres').split(' ')[0]})\nType "help" for help.\n\n`)
      ctx.sh.fg = new PsqlRepl(c.sess, ctx)
      return 'repl'
    }
    const c = connectPg(ctx, o)
    if ('error' in c) {
      ctx.err(c.error + '\n')
      return 2
    }
    if ('needPassword' in c) {
      ctx.sh.fg = new PasswordPrompt(c.prompt, (pw, io) => {
        ctx.sh.fg = undefined
        const r = c.needPassword(pw)
        if ('error' in r) {
          io.err(r.error + '\n')
          return 'exit'
        }
        const res = after(r, io)
        return res === 'repl' ? undefined : 'exit'
      })
      return 0
    }
    const r = after(c, ctx)
    return r === 'repl' ? 0 : r
  },
})

// ---------------------------------------------------------------------------------------
// pg_dump, pg_dumpall y pg_restore
// ---------------------------------------------------------------------------------------

function copyValue(v: unknown): string {
  if (v === null || v === undefined) return '\\N'
  return cell(v, 'postgres').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')
}

export function pgDumpText(s: DbServer, dbName: string, opts: { schemaOnly?: boolean; dataOnly?: boolean; noOwner?: boolean; clean?: boolean; create?: boolean; tables?: string[] }): string {
  const inst = s.dbs.get(dbName)!
  const v = versionOf(s.sys, 'postgres').split(' ')[0]
  let out = `--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version ${v}\n-- Dumped by pg_dump version ${v}\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\nSET client_min_messages = warning;\n\n`
  if (opts.create) out += `--\n-- Name: ${dbName}; Type: DATABASE; Schema: -; Owner: ${inst.owner}\n--\n\n${opts.clean ? `DROP DATABASE IF EXISTS ${dbName};\n` : ''}CREATE DATABASE ${dbName} WITH TEMPLATE = template0 ENCODING = 'UTF8';\n\n${opts.noOwner ? '' : `ALTER DATABASE ${dbName} OWNER TO ${inst.owner};\n\n`}\\connect ${dbName}\n\n`
  const tables = tablesOf(s, inst).filter((t) => !opts.tables?.length || opts.tables.includes(t))
  if (opts.clean && !opts.create) for (const t of tables) out += `DROP TABLE IF EXISTS public.${t};\n`
  if (!opts.dataOnly) {
    for (const t of tables) {
      const owner = inst.tableOwner.get(t) ?? inst.owner
      const ddl = inst.ddl.get(t)!.replace(/;\s*$/, '').replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i, 'CREATE TABLE public.$1')
      out += `--\n-- Name: ${t}; Type: TABLE; Schema: public; Owner: ${owner}\n--\n\n${ddl};\n\n${opts.noOwner ? '' : `\nALTER TABLE public.${t} OWNER TO ${owner};\n\n`}`
    }
  }
  if (!opts.schemaOnly) {
    for (const t of tables) {
      const { columns, rows } = rowsOf(s, inst, t)
      out += `--\n-- Data for Name: ${t}; Type: TABLE DATA; Schema: public; Owner: ${inst.tableOwner.get(t) ?? inst.owner}\n--\n\nCOPY public.${t} (${columns.join(', ')}) FROM stdin;\n${rows.map((r) => r.map(copyValue).join('\t')).join('\n')}${rows.length ? '\n' : ''}\\.\n\n\n`
    }
  }
  if (!opts.dataOnly) for (const [k, v2] of inst.indexes) if (tables.includes(v2.table)) out += `--\n-- Name: ${k}; Type: INDEX; Schema: public; Owner: ${inst.tableOwner.get(v2.table) ?? inst.owner}\n--\n\nCREATE ${v2.unique ? 'UNIQUE ' : ''}INDEX ${k} ON public.${v2.table} (${v2.columns.join(', ')});\n\n\n`
  if (!opts.noOwner) for (const g of s.grants.filter((x) => x.db === dbName && tables.includes(x.table))) out += `GRANT ${[...g.privs].join(',')} ON TABLE public.${g.table} TO ${g.user};\n`
  out += `\n--\n-- PostgreSQL database dump complete\n--\n\n`
  return out
}

const PGDMP = 'PGDMP\u0001\u000f\u0000SIMPGDMP:'

function dumpConnect(ctx: CommandContext, o: PgOpts, tool: string): { sess: Session } | number {
  const c = connectPg(ctx, o, 'postgres')
  if ('error' in c) {
    ctx.err(c.error.replace(/^\S+: error:/, `${tool}: error:`) + '\n')
    return 1
  }
  if ('needPassword' in c) {
    ctx.err(`${tool}: error: connection to server failed: fe_sendauth: no password supplied\n[simulador] Para los respaldos la contraseña va en ~/.pgpass (con permisos 600) o en PGPASSWORD.\n`)
    return 1
  }
  return { sess: c.sess }
}

register('pg_dump', {
  usage: 'pg_dump [-U usuario] [-F p|c] [-f archivo] base',
  async run(ctx) {
    const o = parsePg(ctx.args)
    await loadSql()
    if (!o.db && !o.rest.length) {
      ctx.err('pg_dump: error: no database specified\n')
      return 1
    }
    const c = dumpConnect(ctx, o, 'pg_dump')
    if (typeof c === 'number') return c
    const s = c.sess.server
    const db = c.sess.db!
    const inst = s.dbs.get(db)!
    for (const t of tablesOf(s, inst)) {
      if (!c.sess.user.superuser && inst.tableOwner.get(t) !== c.sess.user.name && !s.grants.some((g) => g.user === c.sess.user.name && g.db === db && g.table === t && (g.privs.has('SELECT') || g.privs.has('ALL')))) {
        ctx.err(`pg_dump: error: query failed: ERROR:  permission denied for table ${t}\npg_dump: detail: Query was: LOCK TABLE public.${t} IN ACCESS SHARE MODE\n`)
        return 1
      }
    }
    const fmt = (o.vals.get('--format') ?? 'p').toLowerCase()[0]
    const text = pgDumpText(s, db, { schemaOnly: o.flags.has('-s') || o.flags.has('--schema-only'), dataOnly: o.flags.has('-a') || o.flags.has('--data-only'), noOwner: o.flags.has('-O') || o.flags.has('--no-owner'), clean: o.flags.has('--clean'), create: o.flags.has('-C') || o.flags.has('--create'), tables: o.vals.get('--table') ? [o.vals.get('--table')!] : undefined })
    const content = fmt === 'c' ? PGDMP + JSON.stringify({ db, owner: inst.owner, sql: pgDumpText(s, db, {}), tables: tablesOf(s, inst) }) : text
    if (fmt === 'd' || fmt === 't') {
      ctx.err('[simulador] Los formatos directory y tar no están simulados: usá -Fc (custom) o el formato de texto.\n')
      return 1
    }
    if (o.file) {
      try {
        ctx.sys.vfs.writeFile(ctx.sh.resolve(o.file), content, ctx.sh.cred, { umask: ctx.sh.umask })
      } catch {
        ctx.err(`pg_dump: error: could not open output file "${o.file}": Permission denied\n`)
        return 1
      }
      return 0
    }
    if (fmt === 'c' && ctx.isTTY) {
      ctx.err('pg_dump: error: refusing to write a custom-format dump to the terminal\n[simulador] Mandalo a un archivo con -f o con >.\n')
      return 1
    }
    ctx.out(content)
    return 0
  },
})

register('pg_dumpall', {
  usage: 'pg_dumpall [-g] [-f archivo]',
  async run(ctx) {
    const o = parsePg(ctx.args)
    await loadSql()
    const c = dumpConnect(ctx, o, 'pg_dumpall')
    if (typeof c === 'number') return c
    const s = c.sess.server
    if (!c.sess.user.superuser) {
      ctx.err('pg_dumpall: error: query failed: ERROR:  permission denied for table pg_authid\n')
      return 1
    }
    let out = `--\n-- PostgreSQL database cluster dump\n--\n\nSET default_transaction_read_only = off;\n\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\n--\n-- Roles\n--\n\n`
    for (const u of s.users) out += `CREATE ROLE ${u.name};\nALTER ROLE ${u.name} WITH ${u.superuser ? 'SUPERUSER' : 'NOSUPERUSER'} INHERIT ${u.superuser ? 'CREATEROLE' : 'NOCREATEROLE'} ${u.createdb ? 'CREATEDB' : 'NOCREATEDB'} ${u.login ? 'LOGIN' : 'NOLOGIN'}${u.password ? ` PASSWORD 'SCRAM-SHA-256$4096:simulado'` : ''};\n`
    if (!o.flags.has('-g') && !o.flags.has('--globals-only') && !o.flags.has('-r') && !o.flags.has('--roles-only')) {
      for (const d of s.dbs.keys()) if (d !== 'postgres') out += '\n' + pgDumpText(s, d, { create: true })
    }
    out += `\n--\n-- PostgreSQL database cluster dump complete\n--\n\n`
    if (o.file) {
      ctx.sys.vfs.writeFile(ctx.sh.resolve(o.file), out, ctx.sh.cred, { umask: ctx.sh.umask })
      return 0
    }
    ctx.out(out)
    return 0
  },
})

register('pg_restore', {
  usage: 'pg_restore [-d base] [-l] [--clean] [-C] archivo',
  async run(ctx) {
    const o = parsePg(ctx.args)
    await loadSql()
    const file = o.rest.at(-1)
    if (!file) {
      ctx.err('pg_restore: error: one of -d/--dbname and -f/--file must be specified\n')
      return 1
    }
    let raw: string
    try {
      raw = ctx.sys.vfs.readFile(ctx.sh.resolve(file), ctx.sh.cred)
    } catch {
      ctx.err(`pg_restore: error: could not open input file "${file}": No such file or directory\n`)
      return 1
    }
    if (!raw.startsWith('PGDMP')) {
      ctx.err('pg_restore: error: input file appears to be a text format dump. Please use psql.\n')
      return 1
    }
    const data = JSON.parse(raw.slice(PGDMP.length)) as { db: string; owner: string; sql: string; tables: string[] }
    if (o.flags.has('-l') || o.flags.has('--list')) {
      let n = 200
      ctx.out(`;\n; Archive created at ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n;     dbname: ${data.db}\n;     TOC Entries: ${data.tables.length * 2 + 5}\n;     Format: CUSTOM\n;\n;\n; Selected TOC Entries:\n;\n${data.tables.map((t) => `${n++}; 1259 16390 TABLE public ${t} ${data.owner}`).join('\n')}\n${data.tables.map((t) => `${n++}; 0 16390 TABLE DATA public ${t} ${data.owner}`).join('\n')}\n`)
      return 0
    }
    if (!o.db) {
      ctx.out(data.sql)
      return 0
    }
    const c = dumpConnect(ctx, { ...o, rest: [] }, 'pg_restore')
    if (typeof c === 'number') return c
    let sql = data.sql
    if (o.flags.has('--clean') || o.flags.has('-c')) sql = data.tables.map((t) => `DROP TABLE IF EXISTS public.${t};`).join('\n') + '\n' + sql
    if (o.flags.has('--no-owner') || o.flags.has('-O')) sql = sql.replace(/^ALTER TABLE .* OWNER TO .*$/gm, '')
    const errs: string[] = []
    const code = runPsqlScript(c.sess, sql, { out: () => undefined, err: (e) => errs.push(e) }, { tuplesOnly: false, unaligned: false, expanded: false, quiet: true, stopOnError: o.flags.has('-e') || o.flags.has('--exit-on-error') })
    if (errs.length) {
      ctx.err(errs.map((e) => `pg_restore: error: could not execute query: ${e.replace(/^psql:[^:]*:\d+: /, '')}`).join('') + `pg_restore: warning: errors ignored on restore: ${errs.length}\n`)
      return 1
    }
    return code ? 1 : 0
  },
})

// ---------------------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------------------

function runAsSql(ctx: CommandContext, sql: string, tool: string): number {
  const o = parsePg(ctx.args)
  const c = connectPg(ctx, { ...o, rest: [], db: 'postgres' })
  if ('error' in c) {
    ctx.err(c.error.replace(/^\S+: error:/, `${tool}: error:`) + '\n')
    return 1
  }
  if ('needPassword' in c) {
    ctx.err(`${tool}: error: fe_sendauth: no password supplied\n`)
    return 1
  }
  const r = execute(c.sess, sql)
  if (r.kind === 'error') {
    ctx.err(`${tool}: error: ${r.text.replace(/^ERROR:\s+/, '')}\n`)
    return 1
  }
  return 0
}

register('createdb', {
  usage: 'createdb [-O dueño] nombre',
  async run(ctx) {
    await loadSql()
    const i = ctx.args.indexOf('-O')
    const owner = ctx.args.find((a) => a.startsWith('--owner='))?.slice(8) ?? (i >= 0 ? ctx.args[i + 1] : undefined)
    const o = parsePg(ctx.args.filter((a, j) => !(i >= 0 && (j === i || j === i + 1)) && !a.startsWith('--owner=')))
    const name = o.rest[0]
    if (!name) {
      ctx.err('createdb: error: missing required argument database name\n')
      return 1
    }
    return runAsSql(ctx, `CREATE DATABASE ${name}${owner ? ` OWNER ${owner}` : ''}`, 'createdb')
  },
})

register('dropdb', {
  usage: 'dropdb nombre',
  async run(ctx) {
    await loadSql()
    const name = parsePg(ctx.args).rest[0]
    if (!name) {
      ctx.err('dropdb: error: missing required argument database name\n')
      return 1
    }
    return runAsSql(ctx, `DROP DATABASE ${name}`, 'dropdb')
  },
})

register('createuser', {
  usage: 'createuser [--createdb] [--superuser] nombre',
  async run(ctx) {
    await loadSql()
    const o = parsePg(ctx.args)
    const name = o.rest[0]
    if (!name) {
      ctx.err('createuser: error: missing required argument role name\n')
      return 1
    }
    if (o.flags.has('-P') || o.flags.has('--pwprompt')) ctx.err('[simulador] --pwprompt pide la clave sin mostrarla; se crea sin clave y después usá ALTER ROLE ... WITH PASSWORD.\n')
    return runAsSql(ctx, `CREATE ROLE ${name} WITH LOGIN${o.flags.has('-d') || o.flags.has('--createdb') ? ' CREATEDB' : ''}${o.flags.has('-s') || o.flags.has('--superuser') ? ' SUPERUSER' : ''}`, 'createuser')
  },
})

register('pg_isready', {
  usage: 'pg_isready [-h servidor]',
  run(ctx) {
    const o = parsePg(ctx.args)
    const t = resolveTarget(ctx.sys, o.host, 5432)
    const label = o.host ? `${o.host}:5432` : '/run/postgresql:5432'
    if ('error' in t || !t.sys.services.get('postgresql')?.active) {
      ctx.out(`${label} - no response\n`)
      return 2
    }
    ctx.out(`${label} - accepting connections\n`)
    return 0
  },
})

register('postgresql-setup', {
  usage: 'postgresql-setup --initdb',
  run(ctx) {
    if (!ctx.args.includes('--initdb')) {
      ctx.err('[simulador] El uso habitual es: sudo postgresql-setup --initdb\n')
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('postgresql-setup: This script must be run as root.\n')
      return 1
    }
    const s = dbServer(ctx.sys, 'postgres')
    const dir = pgDataDir(ctx.sys)
    if (ctx.sys.vfs.exists(`${dir}/PG_VERSION`)) {
      ctx.err(` * Initializing database in '${dir}'\nERROR: Data directory ${dir} is not empty!\nERROR: Initializing database failed, possibly see /var/lib/pgsql/initdb_postgresql.log\n`)
      return 1
    }
    initCluster(ctx.sys)
    s.initialized = true
    ctx.out(` * Initializing database in '${dir}'\n * Initialized, logs are in /var/lib/pgsql/initdb_postgresql.log\n`)
    return 0
  },
})

register('pg_lsclusters', {
  usage: 'pg_lsclusters',
  run(ctx) {
    const on = ctx.sys.services.get('postgresql')?.active
    const v = pgMajor(ctx.sys)
    ctx.out(`Ver Cluster Port Status ${on ? 'Owner    ' : 'Owner    '}Data directory              Log file\n${v}  main    5432 ${on ? 'online' : 'down  '} postgres /var/lib/postgresql/${v}/main /var/log/postgresql/postgresql-${v}-main.log\n`)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Archivos del cluster
// ---------------------------------------------------------------------------------------

export function pgConfText(sys: System): string {
  const ubuntu = sys.distro === 'ubuntu'
  return `# -----------------------------
# PostgreSQL configuration file
# -----------------------------
${ubuntu ? `\ndata_directory = '/var/lib/postgresql/${pgMajor(sys)}/main'\t\t# use data in another directory\nhba_file = '/etc/postgresql/${pgMajor(sys)}/main/pg_hba.conf'\t# host-based authentication file\n` : ''}
#------------------------------------------------------------------------------
# CONNECTIONS AND AUTHENTICATION
#------------------------------------------------------------------------------

# - Connection Settings -

#listen_addresses = 'localhost'\t\t# what IP address(es) to listen on;
\t\t\t\t\t# comma-separated list of addresses;
\t\t\t\t\t# defaults to 'localhost'; use '*' for all
${ubuntu ? 'port = 5432' : '#port = 5432'}\t\t\t\t# (change requires restart)
max_connections = 100\t\t\t# (change requires restart)
${ubuntu ? `unix_socket_directories = '/var/run/postgresql'\t# comma-separated list of directories\n` : ''}
# - Authentication -

#password_encryption = scram-sha-256\t# scram-sha-256 or md5

#------------------------------------------------------------------------------
# RESOURCE USAGE (except WAL)
#------------------------------------------------------------------------------

shared_buffers = 128MB\t\t\t# min 128kB
dynamic_shared_memory_type = posix\t# the default is usually the first option

#------------------------------------------------------------------------------
# WRITE-AHEAD LOG
#------------------------------------------------------------------------------

#wal_level = replica\t\t\t# minimal, replica, or logical
#archive_mode = off\t\t# enables archiving; off, on, or always
#archive_command = ''\t\t# command to use to archive a WAL file

#------------------------------------------------------------------------------
# REPORTING AND LOGGING
#------------------------------------------------------------------------------

${ubuntu ? "log_line_prefix = '%m [%p] %q%u@%d '\t\t# special values:" : "log_destination = 'stderr'\nlogging_collector = on\nlog_directory = 'log'\nlog_filename = 'postgresql-%a.log'"}
#log_min_duration_statement = -1\t# -1 is disabled, 0 logs all statements

log_timezone = 'UTC'
datestyle = 'iso, mdy'
timezone = 'UTC'
lc_messages = 'C.UTF-8'
default_text_search_config = 'pg_catalog.english'
`
}

export function pgHbaText(sys: System): string {
  const host = sys.distro === 'rocky' ? 'ident' : 'scram-sha-256'
  return `# PostgreSQL Client Authentication Configuration File
# ===================================================
#
# Refer to the "Client Authentication" section in the PostgreSQL
# documentation for a complete description of this file.
#
# TYPE  DATABASE        USER            ADDRESS                 METHOD
${sys.distro === 'ubuntu' ? '\n# Database administrative login by Unix domain socket\nlocal   all             postgres                                peer\n' : ''}
# "local" is for Unix domain socket connections only
local   all             all                                     peer
# IPv4 local connections:
host    all             all             127.0.0.1/32            ${host}
# IPv6 local connections:
host    all             all             ::1/128                 ${host}
# Allow replication connections from localhost, by a user with the
# replication privilege.
local   replication     all                                     peer
host    replication     all             127.0.0.1/32            ${host}
host    replication     all             ::1/128                 ${host}
`
}

/** Crea los archivos del cluster (initdb en Rocky, o el cluster que arma el paquete en Ubuntu). */
export function initCluster(sys: System) {
  const data = pgDataDir(sys)
  const conf = pgConfDir(sys)
  const pg = sys.users.get('postgres')
  const mk = (path: string, mode: number) => {
    sys.vfs.mkdirp(path, ROOT_CRED)
    const n = sys.vfs.stat(path, ROOT_CRED)
    n.mode = mode
    if (pg) {
      n.uid = pg.uid
      n.gid = pg.gid
    }
  }
  const write = (path: string, content: string, mode = 0o600) => {
    if (!sys.vfs.exists(path)) sys.vfs.writeFile(path, content, ROOT_CRED, { mode })
    const n = sys.vfs.stat(path, ROOT_CRED)
    if (pg) {
      n.uid = pg.uid
      n.gid = pg.gid
    }
  }
  mk(data, 0o700)
  for (const d of ['base', 'global', 'pg_wal']) mk(`${data}/${d}`, 0o700)
  write(`${data}/PG_VERSION`, pgMajor(sys) + '\n')
  if (conf !== data) mk(conf, 0o755)
  write(`${conf}/postgresql.conf`, pgConfText(sys), sys.distro === 'rocky' ? 0o600 : 0o644)
  write(`${conf}/pg_hba.conf`, pgHbaText(sys), sys.distro === 'rocky' ? 0o600 : 0o640)
}

