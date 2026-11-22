/**
 * Sirve Pyodide (Python compilado a WebAssembly) desde node_modules en desarrollo y copia sus
 * archivos a dist/pyodide/ al compilar, para que la consola de Python funcione sin depender de un CDN.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

const FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']
const TYPES: Record<string, string> = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json' }

export function pyodidePlugin(): Plugin {
  const dir = path.resolve('node_modules/pyodide')
  let base = '/'
  return {
    name: 'pyodide-assets',
    configResolved(c) {
      base = c.base
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        const prefix = `${base}pyodide/`
        if (!url.startsWith(prefix)) return next()
        const name = url.slice(prefix.length)
        if (!FILES.includes(name)) return next()
        res.setHeader('Content-Type', TYPES[path.extname(name)] ?? 'application/octet-stream')
        fs.createReadStream(path.join(dir, name)).pipe(res)
      })
    },
    generateBundle() {
      for (const f of FILES) this.emitFile({ type: 'asset', fileName: `pyodide/${f}`, source: fs.readFileSync(path.join(dir, f)) })
    },
  }
}
