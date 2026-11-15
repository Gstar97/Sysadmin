/**
 * Bases de datos al instalar los paquetes y al armar un ejercicio: bases, usuarios, binlog,
 * historia con hora y respaldos ya hechos. También las verificaciones de los ejercicios.
 */
import { dumpDatabase, dumpFooter, dumpHeader } from '../commands/dbcmd'
import { initCluster } from '../commands/pgcmd'
import type { BashCheck, BashState } from '../schema'
import { System } from '../system'
import { ROOT_CRED } from '../vfs'
import { cell } from './client'
import { ensureLoaded } from './config'
import { accountKey, dbServer, execute, findUser, hasPriv, hasServer, materialize, newDb, parseAccount, splitSql, type DbServer, type Session } from './engine'
import { loadSql, sqlReady } from './sqlite'

// ---------------------------------------------------------------------------------------
// Al instalar los paquetes
// ---------------------------------------------------------------------------------------

function ownedDir(sys: System, path: string, user: string, mode: number, group?: string) {
  sys.vfs.mkdirp(path, ROOT_CRED)
  const n = sys.vfs.stat(path, ROOT_CRED)
  const u = sys.users.get(user)
  n.mode = mode
  if (u) {
    n.uid = u.uid
    n.gid = group ? (sys.groups.get(group)?.gid ?? u.gid) : u.gid
  }
}

System.installHooks['mariadb-server'] = (sys) => {
  ownedDir(sys, '/var/lib/mysql', 'mysql', 0o755)
  if (sys.distro === 'rocky') {
    ownedDir(sys, '/var/log/mariadb', 'mysql', 0o750)
    ownedDir(sys, '/run/mariadb', 'mysql', 0o755)
  } else {
    ownedDir(sys, '/var/log/mysql', 'mysql', 0o2750, 'adm')
    ownedDir(sys, '/run/mysqld', 'mysql', 0o755)
  }
  dbServer(sys, 'mariadb')
}

System.installHooks['postgresql-server'] = (sys) => {
  ownedDir(sys, '/var/lib/pgsql', 'postgres', 0o700)
  dbServer(sys, 'postgres')
}

System.installHooks['postgresql'] = (sys) => {
  if (sys.distro !== 'ubuntu') return
  ownedDir(sys, '/var/lib/postgresql', 'postgres', 0o755)
  ownedDir(sys, '/run/postgresql', 'postgres', 0o2775)
  ownedDir(sys, '/var/log/postgresql', 'postgres', 0o1775)
  initCluster(sys)
  dbServer(sys, 'postgres').initialized = true
}

// ---------------------------------------------------------------------------------------
// Lo que se hace cuando sql.js termina de cargar
// ---------------------------------------------------------------------------------------

const PENDING = new WeakMap<System, (() => void)[]>()

/** Ejecuta lo que quedó esperando a sql.js (historia, respaldos). Lo llaman los comandos y las verificaciones. */
export function runPendingInits(sys: System) {
  if (!sqlReady()) return
  for (const host of [sys, ...sys.lab]) {
    const list = PENDING.get(host)
    if (!list?.length) continue
    PENDING.delete(host)
    for (const f of list) f()
  }
}

function whenReady(sys: System, f: () => void) {
  if (sqlReady()) {
    f()
    return
  }
  const list = PENDING.get(sys) ?? []
  list.push(f)
  PENDING.set(sys, list)
  void loadSql().then(() => runPendingInits(sys))
}

function parseHora(h: string, sys: System): number {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(h.trim())
  const now = new Date(Date.now() + sys.clock.offset * 1000)
  if (!m) return now.getTime()
  const d = m[1] ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setHours(Number(m[4]), Number(m[5]), Number(m[6] ?? 0), 0)
  return d.getTime()
}

/** Agrega log_bin a la configuración del servidor. */
function enableBinlog(sys: System) {
  const path = sys.distro === 'rocky' ? '/etc/my.cnf.d/mariadb-server.cnf' : '/etc/mysql/mariadb.conf.d/50-server.cnf'
  let text: string
  try {
    text = sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return
  }
  if (/^\s*log[_-]bin\b/m.test(text)) return
  if (sys.distro === 'rocky') text = text.replace(/\[mysqld\]\n/, '[mysqld]\nlog-bin=mariadb-bin\nserver-id=1\n')
  else text = text.replace('#server-id              = 1', 'server-id              = 1').replace('#log_bin                = /var/log/mysql/mysql-bin.log', 'log_bin                = /var/log/mysql/mysql-bin.log')
  sys.vfs.writeFile(path, text, ROOT_CRED)
}

function grantFrom(s: DbServer, user: { name: string; host: string }, perm: string) {
  const m = /^(.+?)\s+ON\s+([`"]?[\w*]+[`"]?)\.([`"]?[\w*]+[`"]?)\s*(WITH GRANT OPTION)?$/i.exec(perm.trim())
  if (!m) return
  const privs = new Set(m[1].toUpperCase().replace(/\s+PRIVILEGES\b/, '').split(',').map((x) => x.trim()))
  s.grants.push({ user: accountKey(user, 'mariadb'), db: m[2].replace(/[`"]/g, ''), table: m[3].replace(/[`"]/g, ''), privs, grantOption: !!m[4] })
}

System.initHooks.push((sys: System, state: BashState) => {
  const spec = state.bases_datos
  if (!spec) return
  const my = spec.mariadb
  if (my) {
    const s = dbServer(sys, 'mariadb')
    if (my.binlog) enableBinlog(sys)
    if (sys.services.get('mariadb')?.active) ensureLoaded(sys, 'mariadb')
    for (const [name, sql] of Object.entries(my.bases)) newDb(s, name, 'root').pending.push(sql)
    for (const u of my.usuarios) {
      s.users.push({ name: u.usuario, host: u.host, password: u.clave, plugin: 'password', superuser: false, login: true, createdb: false })
      for (const p of u.permisos) grantFrom(s, { name: u.usuario, host: u.host }, p)
    }
    if (my.historia.length || my.respaldos.length) {
      whenReady(sys, () => {
        const root = s.users.find((u) => u.name === 'root')!
        for (const inst of s.dbs.values()) materialize(s, inst)
        type Item = { t: number; kind: 'sql'; base: string; sql: string } | { t: number; kind: 'dump'; archivo: string; bases: string[]; gz: boolean }
        const items: Item[] = [
          ...my.historia.map((h) => ({ t: parseHora(h.hora, sys), kind: 'sql' as const, base: h.base, sql: h.sql })),
          ...my.respaldos.map((r) => ({ t: parseHora(r.hora, sys), kind: 'dump' as const, archivo: r.archivo, bases: r.bases, gz: r.comprimido })),
        ].sort((a, b) => a.t - b.t)
        for (const it of items) {
          if (it.kind === 'sql') {
            const sess: Session = { server: s, user: root, db: it.base, from: 'localhost', timestamp: it.t }
            for (const st of splitSql(it.sql, 'mariadb')) execute(sess, st)
            continue
          }
          const f = s.binlog.at(-1)
          let text = dumpHeader(s, 'localhost', it.bases.join(' '))
          if (s.loaded?.logBin) text += `--\n-- Position to start replication or point-in-time recovery from\n--\n\n-- CHANGE MASTER TO MASTER_LOG_FILE='${f?.name ?? ''}', MASTER_LOG_POS=${f?.size ?? 4};\n\n`
          for (const b of it.bases) if (s.dbs.has(b)) text += dumpDatabase(s, b, { withCreateDb: true, noData: false })
          text += dumpFooter(it.t)
          sys.vfs.mkdirp(it.archivo.slice(0, it.archivo.lastIndexOf('/')) || '/', ROOT_CRED)
          sys.vfs.writeFile(it.archivo, it.gz ? '\u001f\u008b\u0008' + text : text, ROOT_CRED, { mode: 0o600 })
          sys.vfs.stat(it.archivo, ROOT_CRED).mtime = it.t
        }
      })
    }
  }
  const pg = spec.postgresql
  if (pg) {
    const s = dbServer(sys, 'postgres')
    if (pg.inicializado && sys.installed.has(sys.distro === 'rocky' ? 'postgresql-server' : 'postgresql')) {
      initCluster(sys)
      s.initialized = true
    } else if (!pg.inicializado) s.initialized = false
    for (const r of pg.roles) s.users.push({ name: r.nombre, host: '', password: r.clave, plugin: 'password', superuser: r.superusuario, login: r.login, createdb: r.crear_bases })
    for (const [name, b] of Object.entries(pg.bases)) {
      const inst = newDb(s, name, b.dueno)
      if (b.sql) inst.pending.push(b.sql)
    }
    if (s.initialized && sys.services.get('postgresql')?.active) ensureLoaded(sys, 'postgres')
  }
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

type Single = Exclude<BashCheck, { en: string }>

export function verifyDb(sys: System, check: Single): { ok: boolean; label: string } | undefined {
  if (!('base_datos' in check) && !('consulta_bd' in check) && !('usuario_bd' in check)) return undefined
  runPendingInits(sys)
  const kind = check.motor === 'mariadb' ? 'mariadb' : 'postgres'
  const existe = 'existe' in check ? (check.existe ?? true) : true
  const tiene = 'tiene' in check ? (check.tiene ?? true) : true
  const s = hasServer(sys, kind)
  const motor = check.motor === 'mariadb' ? 'MariaDB' : 'PostgreSQL'
  if ('base_datos' in check) {
    const ok = !!s?.dbs.has(check.base_datos) === existe
    return { ok, label: `${existe ? 'existe' : 'no existe'} la base ${check.base_datos} en ${motor}` }
  }
  if ('consulta_bd' in check) {
    const label = `en ${motor}, "${check.consulta_bd}" sobre ${check.base} da ${check.resultado}`
    const inst = s?.dbs.get(check.base)
    if (!s || !inst || !materialize(s, inst)) return { ok: false, label }
    const admin = s.users.find((u) => u.superuser)!
    const r = execute({ server: s, user: admin, db: check.base, from: 'localhost', noLog: true }, check.consulta_bd)
    const v = r.kind === 'rows' && r.rows[0] ? cell(r.rows[0][0], kind, 'NULL') : r.kind === 'rows' ? '' : `(${r.kind === 'error' ? r.text : 'sin filas'})`
    return { ok: v === check.resultado, label }
  }
  const acc = kind === 'mariadb' ? parseAccount(check.host ? `'${check.usuario_bd}'@'${check.host}'` : check.usuario_bd) : { name: check.usuario_bd, host: '' }
  const u = s ? findUser(s, acc.name, kind === 'mariadb' ? (check.host ?? (check.usuario_bd.includes('@') ? acc.host : undefined)) : undefined) : undefined
  const who = kind === 'mariadb' ? `'${acc.name}'@'${u?.host ?? acc.host}'` : acc.name
  if (!check.permiso) {
    let ok = !!u === existe
    if (ok && u && check.clave !== undefined) ok = u.password === check.clave
    return { ok, label: `${existe ? 'existe' : 'no existe'} el usuario ${who} en ${motor}${check.clave !== undefined ? ' con esa contraseña' : ''}` }
  }
  const label = `${who} ${tiene ? 'puede' : 'no puede'} ${check.permiso} en ${check.base ?? '*'}${check.tabla ? '.' + check.tabla : ''}`
  if (!s || !u) return { ok: !tiene, label }
  const sess: Session = { server: s, user: u, from: 'localhost' }
  const db = check.base ?? '*'
  const ok = (check.permiso.toUpperCase() === 'CREATE' ? hasPriv(sess, 'CREATE', db) : hasPriv(sess, check.permiso.toUpperCase(), db, check.tabla ?? '*')) === tiene
  return { ok, label }
}
