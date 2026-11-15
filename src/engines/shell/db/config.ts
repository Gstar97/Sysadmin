/**
 * Configuración de MariaDB y PostgreSQL leída de sus archivos, y lo que pasa al arrancar
 * (systemctl start/restart) y al recargar (reload): la configuración vale desde ese momento.
 */
import { SERVICE_CHECKS } from '../commands/sysinfo'
import type { System } from '../system'
import { ROOT_CRED } from '../vfs'
import { dbServer, pgConfDir, pgDataDir, writeBinlogFiles, type DbConfig, type HbaRule } from './engine'

function read(sys: System, path: string): string {
  try {
    return sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return ''
  }
}

function list(sys: System, dir: string): string[] {
  try {
    return sys.vfs
      .readdir(dir, ROOT_CRED)
      .filter((n) => n.endsWith('.cnf'))
      .sort()
      .map((n) => `${dir}/${n}`)
  } catch {
    return []
  }
}

/** Archivos de configuración de MariaDB, en el orden en que se leen. */
export function myCnfFiles(sys: System): string[] {
  if (sys.distro === 'rocky') return ['/etc/my.cnf', ...list(sys, '/etc/my.cnf.d')]
  return ['/etc/mysql/my.cnf', ...list(sys, '/etc/mysql/conf.d'), ...list(sys, '/etc/mysql/mariadb.conf.d')]
}

/** Opciones del servidor MariaDB ([server], [mysqld], [mariadb], [mariadbd]). */
export function readMyCnf(sys: System): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of myCnfFiles(sys)) {
    let section = ''
    for (const raw of read(sys, f).split('\n')) {
      const line = raw.replace(/[#;].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([^\]]+)\]$/.exec(line)
      if (sec) {
        section = sec[1].toLowerCase()
        continue
      }
      if (!/^(server|mysqld|mariadb|mariadbd|mariadb-[\d.]+)$/.test(section)) continue
      const [k, ...v] = line.split('=')
      out.set(k.trim().replace(/-/g, '_').toLowerCase(), v.join('=').trim())
    }
  }
  return out
}

/** Opciones de cliente de ~/.my.cnf ([client], [mysql]). */
export function readClientCnf(sys: System, home: string): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const raw of read(sys, `${home}/.my.cnf`).split('\n')) {
    const line = raw.replace(/^[#;].*$/, '').trim()
    if (!line) continue
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) {
      section = sec[1].toLowerCase()
      continue
    }
    if (!/^(client|mysql|mysqldump|mariadb-dump|client-mariadb)$/.test(section)) continue
    const [k, ...v] = line.split('=')
    out.set(k.trim().replace(/-/g, '_').toLowerCase(), v.join('=').trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

function myConfig(sys: System): DbConfig {
  const c = readMyCnf(sys)
  let logBin = c.get('log_bin')
  if (logBin !== undefined) {
    if (logBin === '' || logBin === 'ON' || logBin === '1') logBin = `/var/lib/mysql/${sys.hostname}-bin`
    else if (!logBin.startsWith('/')) logBin = `/var/lib/mysql/${logBin}`
    logBin = logBin.replace(/\.log$/, '')
  }
  return {
    bind: c.get('bind_address') ?? (c.has('skip_networking') ? 'skip-networking' : ''),
    port: Number(c.get('port') ?? 3306),
    logBin,
    serverId: Number(c.get('server_id') ?? 1),
    maxConnections: Number(c.get('max_connections') ?? 151),
    slowLog: ['1', 'on'].includes((c.get('slow_query_log') ?? '').toLowerCase()),
    longQueryTime: Number(c.get('long_query_time') ?? 10),
    listen: '',
    hba: [],
  }
}

export function readPgConf(sys: System): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of read(sys, `${pgConfDir(sys)}/postgresql.conf`).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\w+)\s*=?\s*(.+)$/.exec(line)
    if (m) out.set(m[1].toLowerCase(), m[2].trim().replace(/^'(.*)'$/, '$1'))
  }
  return out
}

export function readHba(sys: System): HbaRule[] {
  const rules: HbaRule[] = []
  read(sys, `${pgConfDir(sys)}/pg_hba.conf`)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/#.*$/, '').trim()
      if (!line) return
      const p = line.split(/\s+/)
      const type = p[0] as HbaRule['type']
      if (type === 'local') rules.push({ type, db: p[1], user: p[2], method: p[3] ?? '', line: i + 1 })
      else if (/^host/.test(type)) {
        const addr = /^\d+\.\d+\.\d+\.\d+$/.test(p[3] ?? '') && /^\d+\.\d+\.\d+\.\d+$/.test(p[4] ?? '') ? `${p[3]}/${maskBits(p[4])}` : p[3]
        rules.push({ type, db: p[1], user: p[2], address: addr, method: (addr === p[3] ? p[4] : p[5]) ?? '', line: i + 1 })
      }
    })
  return rules
}

function maskBits(mask: string): number {
  return mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)
}

function pgConfig(sys: System): DbConfig {
  const c = readPgConf(sys)
  return {
    bind: '',
    port: Number(c.get('port') ?? 5432),
    serverId: 0,
    maxConnections: Number(c.get('max_connections') ?? 100),
    slowLog: false,
    longQueryTime: 0,
    listen: c.get('listen_addresses') ?? 'localhost',
    hba: readHba(sys),
  }
}

/** Al arrancar MariaDB: lee la configuración. */
function mariadbStart(ctx: { sys: System }): string | undefined {
  const s = dbServer(ctx.sys, 'mariadb')
  const cfg = myConfig(ctx.sys)
  if (cfg.logBin && (!s.loaded?.logBin || s.loaded.logBin !== cfg.logBin)) {
    s.loaded = cfg
    // Cada arranque con log_bin abre un archivo nuevo.
    const last = s.binlog.at(-1)
    const n = last ? Number(last.name.split('.').pop()) + 1 : 1
    s.binlog.push({ name: `${cfg.logBin.split('/').pop()}.${String(n).padStart(6, '0')}`, events: [], size: 256 })
    writeBinlogFiles(s)
  }
  s.loaded = cfg
  return undefined
}

/** Al arrancar PostgreSQL: en Rocky, el cluster tiene que existir (postgresql-setup --initdb). */
function postgresStart(ctx: { sys: System }): string | undefined {
  const sys = ctx.sys
  const s = dbServer(sys, 'postgres')
  if (!s.initialized || !sys.vfs.exists(`${pgDataDir(sys)}/PG_VERSION`)) {
    return `Directory "${pgDataDir(sys)}" is missing or empty.\nUse "/usr/bin/postgresql-setup --initdb"\nto initialize the database cluster.\nSee /usr/share/doc/postgresql/README.rpm-dist for more information.`
  }
  const svc = sys.services.get('postgresql')
  const cfg = pgConfig(sys)
  // reload: pg_hba.conf y casi todo se aplican; listen_addresses y port, recién al reiniciar.
  if (svc?.active && s.loaded) s.loaded = { ...cfg, listen: s.loaded.listen, port: s.loaded.port }
  else s.loaded = cfg
  return undefined
}

SERVICE_CHECKS['mariadb'] = mariadbStart
SERVICE_CHECKS['postgresql'] = postgresStart

/** Configuración vigente, leyendo los archivos si el servicio nunca arrancó desde este simulador. */
export function ensureLoaded(sys: System, kind: 'mariadb' | 'postgres') {
  const s = dbServer(sys, kind)
  if (s.loaded) return s
  if (kind === 'mariadb') mariadbStart({ sys })
  else if (s.initialized) s.loaded = pgConfig(sys)
  return s
}
