import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { content, getLesson } from '@/content'
import { EmptyState, PageHeader, RichText } from '@/ui'

function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export default function GlossaryPage() {
  const [filter, setFilter] = useState('')
  const entries = useMemo(
    () => [...content.glossary].sort((a, b) => a.termino.localeCompare(b.termino, 'es', { sensitivity: 'base' })),
    [],
  )
  const shown = entries.filter((e) => {
    if (!filter.trim()) return true
    const f = normalize(filter)
    return [e.termino, ...e.alias, e.definicion].some((t) => normalize(t).includes(f))
  })
  const groups = new Map<string, typeof shown>()
  for (const e of shown) {
    const letter = normalize(e.termino)[0]?.toUpperCase() ?? '#'
    const key = /[A-Z]/.test(letter) ? letter : '#'
    groups.set(key, [...(groups.get(key) ?? []), e])
  }

  return (
    <div>
      <PageHeader eyebrow="Glosario general" title="Términos de la carrera">
        Cada término enlaza a la lección donde se explica a fondo.
      </PageHeader>
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filtrar términos…"
        aria-label="Filtrar términos"
        className="mb-6 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent sm:max-w-md"
      />
      {entries.length === 0 ? (
        <EmptyState title="El glosario todavía está vacío">Los términos se agregan junto con las lecciones que los explican.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Ningún término coincide con el filtro" />
      ) : (
        <div className="space-y-8">
          {[...groups.entries()].map(([letter, items]) => (
            <section key={letter}>
              <h2 className="mb-3 border-b border-line pb-1 text-xl font-bold text-accent">{letter}</h2>
              <dl className="space-y-4">
                {items.map((e) => {
                  const lesson = e.leccion ? getLesson(e.leccion) : undefined
                  return (
                    <div key={e.id} id={e.id} className="scroll-mt-20 rounded-lg border border-line bg-surface p-4">
                      <dt className="font-semibold">
                        {e.termino}
                        {e.alias.length > 0 && <span className="ml-2 text-sm font-normal text-muted">({e.alias.join(', ')})</span>}
                      </dt>
                      <dd className="mt-1">
                        <RichText text={e.definicion} />
                        {lesson && (
                          <Link to={`/leccion/${lesson.id}`} className="mt-2 inline-block text-sm text-accent">
                            Se explica en {lesson.numero} {lesson.titulo}
                          </Link>
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
