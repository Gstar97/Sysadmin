/**
 * Carga perezosa de sql.js (SQLite compilado a WebAssembly, con el binario incluido en el JS).
 * Es el motor que guarda y consulta los datos de las bases simuladas de MariaDB y PostgreSQL;
 * la "personalidad" de cada servidor (sintaxis, usuarios, permisos, mensajes) está en engine.ts.
 */

export interface SqlResult {
  columns: string[]
  values: unknown[][]
}

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): SqlResult[]
  getRowsModified(): number
  close(): void
}

export interface SqlStatic {
  Database: new (data?: Uint8Array) => SqlDatabase
}

let sql: SqlStatic | undefined
let loading: Promise<SqlStatic> | undefined

/** Empieza a cargar sql.js (si no se cargó todavía) y devuelve la promesa. */
export function loadSql(): Promise<SqlStatic> {
  if (sql) return Promise.resolve(sql)
  loading ??= import('sql.js/dist/sql-wasm-inline.js').then(async (mod) => {
    const init = ((mod as { default?: unknown }).default ?? mod) as () => Promise<SqlStatic>
    sql = await init()
    return sql
  })
  return loading
}

/** sql.js ya está listo para usar de forma sincrónica. */
export function sqlReady(): SqlStatic | undefined {
  return sql
}
