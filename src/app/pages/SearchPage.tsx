import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { SearchDoc } from '@/content/types'
import { getSearchIndex, snippet } from '@/search'
import { Badge, EmptyState, Icon, PageHeader, Spinner } from '@/ui'

type Hit = SearchDoc & { score: number; terms: string[] }

const TIPO: Record<SearchDoc['tipo'], string> = { leccion: 'Lección', modulo: 'Módulo', glosario: 'Glosario' }

export default function SearchPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const q = params.get('q') ?? ''
  const [input, setInput] = useState(q)
  const [hits, setHits] = useState<Hit[] | null>(null)

  useEffect(() => {
    setInput(q)
    if (!q.trim()) {
      setHits([])
      return
    }
    let cancelled = false
    setHits(null)
    void getSearchIndex().then((ms) => {
      if (cancelled) return
      let results = ms.search(q)
      if (results.length === 0) results = ms.search(q, { combineWith: 'OR' })
      setHits(results.slice(0, 40).map((r) => ({ ...(r as unknown as SearchDoc), id: String(r.id), score: r.score, terms: r.terms })))
    })
    return () => {
      cancelled = true
    }
  }, [q])

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow="Buscador" title="Buscar en toda la carrera" />
      <form
        role="search"
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          navigate(`/buscar?q=${encodeURIComponent(input.trim())}`)
        }}
      >
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-accent">
          <Icon name="search" className="text-muted" />
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full bg-transparent py-2.5 outline-none"
            placeholder="Por ejemplo: permisos, subnetting, DNS…"
            aria-label="Texto a buscar"
          />
        </label>
      </form>
      {hits === null ? (
        <Spinner label="Buscando…" />
      ) : !q.trim() ? (
        <p className="text-muted">Escribir una palabra o frase para buscar en lecciones, módulos y glosario.</p>
      ) : hits.length === 0 ? (
        <EmptyState title={`No hay resultados para "${q}"`}>Probar con otra palabra o revisar el glosario.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {hits.map((h) => (
            <li key={h.id}>
              <Link to={h.url} className="block rounded-lg border border-line bg-surface p-4 no-underline hover:border-accent">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{TIPO[h.tipo]}</Badge>
                  <span className="font-semibold text-fg">{h.titulo}</span>
                  {h.seccion && <span className="text-sm text-muted">› {h.seccion}</span>}
                </div>
                <p className="mt-1.5 text-sm text-muted">{snippet(h.texto, h.terms)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
