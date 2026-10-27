import type { Plugin } from 'vite'
import { parse } from 'yaml'

/** Permite importar archivos .yaml como módulos: `import ejercicio from './ejercicio.yaml'`. */
export function yamlPlugin(): Plugin {
  return {
    name: 'carrera:yaml',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!/\.ya?ml$/.test(file)) return null
      try {
        const data = parse(code, { prettyErrors: true })
        return { code: `export default ${JSON.stringify(data ?? null)}`, map: null }
      } catch (e) {
        this.error(`YAML inválido en ${file}: ${(e as Error).message}`)
      }
    },
  }
}
