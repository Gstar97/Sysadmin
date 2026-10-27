import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { scanContent } from './content-scan.ts'

const INDEX_ID = 'virtual:content'
const SEARCH_ID = 'virtual:search-docs'
const RESOLVED_INDEX = '\0' + INDEX_ID
const RESOLVED_SEARCH = '\0' + SEARCH_ID

/**
 * Expone el índice de la carrera (virtual:content) y los documentos del buscador
 * (virtual:search-docs) generados a partir de la carpeta de contenido.
 * En la compilación de producción, cualquier error de contenido detiene la compilación.
 */
export function contentPlugin(options: { contentDir: string }): Plugin {
  const contentDir = path.resolve(options.contentDir)
  let isBuild = false
  let reported = ''

  function scan() {
    const result = scanContent(contentDir)
    const report = [...result.errors.map((e) => `✖ ${e}`), ...result.warnings.map((w) => `⚠ ${w}`)].join('\n')
    if (report && report !== reported) {
      console.warn(`\n[contenido] ${result.errors.length} errores, ${result.warnings.length} avisos\n${report}\n`)
    }
    reported = report
    return result
  }

  return {
    name: 'carrera:content',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    resolveId(id) {
      if (id === INDEX_ID) return RESOLVED_INDEX
      if (id === SEARCH_ID) return RESOLVED_SEARCH
      return null
    },
    load(id) {
      if (id !== RESOLVED_INDEX && id !== RESOLVED_SEARCH) return null
      const result = scan()
      if (isBuild && result.errors.length) {
        this.error(`El contenido tiene ${result.errors.length} errores:\n${result.errors.join('\n')}`)
      }
      for (const file of [contentDir]) this.addWatchFile(file)
      const data = id === RESOLVED_INDEX ? result.index : result.searchDocs
      return `export default ${JSON.stringify(data)}`
    },
    configureServer(server: ViteDevServer) {
      server.watcher.add(contentDir)
      const onChange = (file: string) => {
        if (!path.resolve(file).startsWith(contentDir)) return
        for (const id of [RESOLVED_INDEX, RESOLVED_SEARCH]) {
          const mod = server.moduleGraph.getModuleById(id)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', onChange)
      server.watcher.on('unlink', onChange)
      server.watcher.on('change', (file) => {
        // Los cambios dentro de una lección los maneja la recarga normal de Vite;
        // los archivos de estructura o metadatos requieren regenerar el índice.
        if (/\.(ya?ml|mdx)$/.test(file)) onChange(file)
      })
    },
  }
}
