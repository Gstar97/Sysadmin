import { beforeAll, describe, expect, it } from 'vitest'
import { createBashSession, loadSql, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

beforeAll(async () => {
  await loadSql()
})

async function session(state: BashStateInput) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')) }
  }
  return { sh, run }
}

const maria: BashStateInput = {
  distro: 'rocky',
  hostname: 'db01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true }],
  paquetes: { instalados: ['mariadb-server'] },
  servicios: { mariadb: { activo: true } },
  bases_datos: { mariadb: { bases: { tienda: "CREATE TABLE clientes (id INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(100) NOT NULL); INSERT INTO clientes (nombre) VALUES ('Muebles del Sur'), ('Oficinas Norte');" } } },
}

describe('MariaDB', () => {
  it('root entra solo con sudo (unix_socket); el cliente interactivo cambia el prompt', async () => {
    const { sh, run } = await session(maria)
    expect((await run('mysql')).err).toContain("ERROR 1045 (28000): Access denied for user 'ana'@'localhost'")
    await run('sudo mysql')
    expect(sh.prompt()).toBe('MariaDB [(none)]> ')
    await run('USE tienda;')
    expect(sh.prompt()).toBe('MariaDB [tienda]> ')
    expect((await run('SELECT nombre FROM clientes WHERE id = 2;')).out).toContain('| Oficinas Norte |')
    await run('SELECT nombre')
    expect(sh.prompt()).toBe('    -> ')
    expect((await run('FROM clientes;')).out).toContain('2 rows in set')
    expect((await run('exit')).out).toBe('Bye\n')
    expect(sh.fg).toBeUndefined()
  })

  it('usuario con permisos mínimos, contraseña oculta y errores de permiso', async () => {
    const { sh, run } = await session(maria)
    await run(`sudo mysql -e "CREATE USER 'app'@'localhost' IDENTIFIED BY 'Clave2026'; GRANT SELECT, INSERT ON tienda.* TO 'app'@'localhost';"`)
    expect(verifyBash(sh, { usuario_bd: 'app', host: 'localhost', motor: 'mariadb', permiso: 'INSERT', base: 'tienda', existe: true, tiene: true }).ok).toBe(true)
    expect(verifyBash(sh, { usuario_bd: 'app', host: 'localhost', motor: 'mariadb', permiso: 'DELETE', base: 'tienda', existe: true, tiene: false }).ok).toBe(true)
    expect((await run("mysql -u app -pClave2026 tienda -e 'DELETE FROM clientes'")).err).toContain('ERROR 1142 (42000) at line 1: DELETE command denied')
    await run('mysql -u app -p tienda')
    expect(sh.fg?.secret).toBe(true)
    await run('Clave2026')
    expect(sh.prompt()).toBe('MariaDB [tienda]> ')
    await run("INSERT INTO clientes (nombre) VALUES ('Nuevo');")
    await run('exit')
    expect(verifyBash(sh, { consulta_bd: 'SELECT count(*) FROM clientes', motor: 'mariadb', base: 'tienda', resultado: '3' }).ok).toBe(true)
  })

  it('recuperación a un punto en el tiempo: respaldo de las 3:00 más el binlog hasta antes del DROP', async () => {
    const { sh, run } = await session({
      ...maria,
      paquetes: { instalados: ['mariadb-server', 'gzip'] },
      bases_datos: {
        mariadb: {
          bases: { tienda: "CREATE TABLE pedidos (id INT AUTO_INCREMENT PRIMARY KEY, cliente VARCHAR(50), total DECIMAL(10,2)); INSERT INTO pedidos (cliente, total) VALUES ('A', 100);" },
          binlog: true,
          historia: [
            { hora: '02:10', base: 'tienda', sql: "INSERT INTO pedidos (cliente, total) VALUES ('B', 200)" },
            { hora: '09:15', base: 'tienda', sql: "INSERT INTO pedidos (cliente, total) VALUES ('C', 300)" },
            { hora: '11:42:07', base: 'tienda', sql: 'DROP TABLE pedidos' },
          ],
          respaldos: [{ archivo: '/var/backups/db/tienda.sql.gz', hora: '03:00', bases: ['tienda'], comprimido: true }],
        },
      },
    })
    const pos = /MASTER_LOG_POS=(\d+)/.exec((await run('sudo zcat /var/backups/db/tienda.sql.gz | grep "CHANGE MASTER"')).out)?.[1]
    expect(pos).toBeDefined()
    expect((await run('sudo mysqlbinlog /var/lib/mysql/mariadb-bin.000001 | grep -B3 "DROP TABLE"')).out).toMatch(/11:42:07/)
    await run('sudo zcat /var/backups/db/tienda.sql.gz | sudo mysql')
    expect(verifyBash(sh, { consulta_bd: 'SELECT count(*) FROM pedidos', motor: 'mariadb', base: 'tienda', resultado: '2' }).ok).toBe(true)
    const local = new Date()
    const ymd = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    await run(`sudo mysqlbinlog --start-position=${pos} --stop-datetime="${ymd} 11:42:00" /var/lib/mysql/mariadb-bin.000001 | sudo mysql`)
    expect(verifyBash(sh, { consulta_bd: 'SELECT count(*) FROM pedidos', motor: 'mariadb', base: 'tienda', resultado: '3' }).ok).toBe(true)
  })
})

describe('PostgreSQL', () => {
  const pg: BashStateInput = {
    distro: 'rocky',
    hostname: 'db01',
    usuario: 'ana',
    usuarios: [{ nombre: 'ana', sudo: true }],
    paquetes: { instalados: ['postgresql-server'] },
    servicios: { postgresql: { activo: true } },
    bases_datos: {
      postgresql: {
        roles: [{ nombre: 'app', clave: 'Clave2026' }, { nombre: 'informes', clave: 'Inf2026' }],
        bases: { inventario: { dueno: 'app', sql: "CREATE TABLE productos (id SERIAL PRIMARY KEY, nombre VARCHAR(100)); INSERT INTO productos (nombre) VALUES ('Silla'), ('Mesa');" } },
      },
    },
  }

  it('en Rocky hay que inicializar el cluster antes de arrancar', async () => {
    const { run } = await session({ distro: 'rocky', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['postgresql-server'] } })
    expect((await run('sudo systemctl start postgresql')).err).toContain('Job for postgresql.service failed')
    expect((await run('sudo postgresql-setup --initdb')).out).toContain('Initialized')
    await run('sudo systemctl start postgresql')
    expect((await run('sudo -u postgres psql -c "SELECT 1 AS uno"')).out).toContain('uno')
  })

  it('peer, ident y contraseña según pg_hba.conf; esquema public y GRANT ON ALL TABLES', async () => {
    const { sh, run } = await session(pg)
    expect((await run('psql -U postgres')).err).toContain('Peer authentication failed for user "postgres"')
    expect((await run('PGPASSWORD=Clave2026 psql -h 127.0.0.1 -U app -d inventario -c "SELECT 1"')).err).toContain('Ident authentication failed for user "app"')
    await run("sudo sed -i 's/127.0.0.1\\/32            ident/127.0.0.1\\/32            scram-sha-256/' /var/lib/pgsql/data/pg_hba.conf && sudo systemctl reload postgresql")
    expect((await run('PGPASSWORD=Clave2026 psql -h 127.0.0.1 -U app -d inventario -c "SELECT count(*) FROM productos"')).out).toMatch(/count\s*\n-+\n\s+2/)
    expect((await run('PGPASSWORD=Inf2026 psql -h 127.0.0.1 -U informes -d inventario -c "SELECT * FROM productos"')).err).toContain('permission denied for table productos')
    expect((await run('PGPASSWORD=Inf2026 psql -h 127.0.0.1 -U informes -d inventario -c "CREATE TABLE x (a int)"')).err).toContain('permission denied for schema public')
    await run('sudo -u postgres psql -d inventario -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO informes"')
    expect(verifyBash(sh, { usuario_bd: 'informes', motor: 'postgresql', permiso: 'SELECT', base: 'inventario', tabla: 'productos', existe: true, tiene: true }).ok).toBe(true)
  })

  it('pg_dump en formato custom y pg_restore en otra base', async () => {
    const { sh, run } = await session(pg)
    await run('sudo -u postgres pg_dump -Fc -f /tmp/inv.dump inventario')
    expect((await run('sudo -u postgres psql -f /tmp/inv.dump')).err).toContain('custom-format dump')
    await run('sudo -u postgres createdb prueba && sudo -u postgres pg_restore -d prueba /tmp/inv.dump')
    expect(verifyBash(sh, { consulta_bd: 'SELECT count(*) FROM productos', motor: 'postgresql', base: 'prueba', resultado: '2' }).ok).toBe(true)
  })
})
