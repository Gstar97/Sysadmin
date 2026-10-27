import MiniSearch from 'minisearch'
import type { SearchDoc } from '@/content/types'

let instance: Promise<MiniSearch<SearchDoc>> | undefined

function normalize(term: string) {
  return term
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/** Carga el índice la primera vez que se busca (va en un archivo aparte para no pesar en el inicio). */
export function getSearchIndex(): Promise<MiniSearch<SearchDoc>> {
  instance ??= import('virtual:search-docs').then(({ default: docs }) => {
    const ms = new MiniSearch<SearchDoc>({
      fields: ['titulo', 'seccion', 'texto'],
      storeFields: ['titulo', 'seccion', 'texto', 'url', 'tipo'],
      processTerm: (t) => normalize(t),
      searchOptions: { boost: { titulo: 3, seccion: 2 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
    })
    ms.addAll(docs)
    return ms
  })
  return instance
}

/** Fragmento de texto alrededor de la primera coincidencia. */
export function snippet(text: string, terms: string[], size = 180): string {
  const plain = normalize(text)
  let pos = -1
  for (const t of terms) {
    const i = plain.indexOf(normalize(t))
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (pos < 0) return text.slice(0, size) + (text.length > size ? '…' : '')
  const start = Math.max(0, pos - 60)
  return (start > 0 ? '…' : '') + text.slice(start, start + size) + (start + size < text.length ? '…' : '')
}
